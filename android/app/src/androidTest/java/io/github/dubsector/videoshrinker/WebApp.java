package io.github.dubsector.videoshrinker;

import static org.junit.Assert.fail;

import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.graphics.Rect;
import android.net.Uri;
import android.os.Build;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
import android.util.Log;

import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.By;
import androidx.test.uiautomator.UiDevice;
import androidx.test.uiautomator.UiObject2;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Drives the app and its web page for the Firebase Test Lab tests. Test Lab
 * offers no adb to reach Chrome over DevTools the way the emulator test does
 * (android/emulator-test), so this goes through Chrome's accessibility tree
 * with UiAutomator, finding the page's controls by their English labels: the
 * device locale must be English.
 *
 * The test video and Chrome's command line are pushed to /data/local/tmp by
 * the test run (android/test-lab/run-firebase-test.sh). Screenshots go to
 * /sdcard/test-lab; what was seen is logged under the TestLabSmoke tag.
 */
final class WebApp {

    static final String TAG = "TestLabSmoke";
    static final String CHROME = "com.android.chrome";
    static final String VIDEO = "/data/local/tmp/smoke-test.mp4";
    private static final String SHOTS = "/sdcard/test-lab";
    private static final int TARGET_MB = 2;

    static final Pattern CONVERT = Pattern.compile("Convert");
    private static final Pattern DOWNLOAD = Pattern.compile("Download");
    private static final Pattern PROGRESS = Pattern.compile("(Paused · )?\\d+%");
    private static final Pattern ENGINE = Pattern.compile(
            "WebCodecs, hardware-accelerated|WebCodecs, software encoder|ffmpeg\\.wasm, CPU fallback"
                    + "|Left as-is, nothing to shrink|Metadata stripped, video left untouched"
                    + "|This footage doesn't compress below its current size.*");
    // Everything the web app shows in its error box (src/locales/en.json,
    // errors), and the share relay's own failure (strings.xml).
    private static final Pattern ERROR = Pattern.compile(
            "Please choose a video file\\.|Conversion failed\\..*|Gave up waiting for the shared video\\..*"
                    + "|The shared video never arrived from the system\\..*|Could not receive the shared video.*"
                    + "|No video found.*|Could not receive the video: .*");

    final Instrumentation instrumentation;
    final Context app;
    final UiDevice device;
    private static int shotCount;

    WebApp() {
        instrumentation = InstrumentationRegistry.getInstrumentation();
        app = instrumentation.getTargetContext();
        device = UiDevice.getInstance(instrumentation);
        shell("mkdir -p " + SHOTS);
        // Conversions post a notification while running; don't let the
        // permission prompt cover the page.
        shell("pm grant " + app.getPackageName() + " android.permission.POST_NOTIFICATIONS");
        // Chrome only reads /data/local/tmp/chrome-command-line when it is the
        // debug app. The flags there skip its first-run screens and the Digital
        // Asset Links check, which the debug signing key would fail.
        shell("am set-debug-app --persistent " + CHROME);
        shell("am force-stop " + CHROME);
        log("Chrome " + versionOf(CHROME) + ", Android " + Build.VERSION.RELEASE
                + ", " + Build.MANUFACTURER + " " + Build.MODEL);
    }

    // Launches the app and waits for the web app to be ready to take a share.
    void start() {
        launch(true);
        waitFor(CONVERT, 90_000, "the web app to render");
        // The share target is handled by the service worker, so a share sent
        // before it controls the page would be lost. There is no way to see
        // that from here, so give a first load time to install it.
        SystemClock.sleep(10_000);
        shot("launched");
    }

    void launch(boolean fresh) {
        Intent launch = app.getPackageManager().getLaunchIntentForPackage(app.getPackageName());
        if (launch == null) fail("the app has no launcher activity");
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | (fresh ? Intent.FLAG_ACTIVITY_CLEAR_TASK : 0));
        app.startActivity(launch);
    }

    // Copies the test video into the app's own files, where its FileProvider
    // serves it as twa_splash/<name>.
    File copyVideoToApp(String name) throws IOException {
        File dir = new File(app.getFilesDir(), "twa_splash");
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("could not create " + dir);
        File file = new File(dir, name);
        try (InputStream in = shellStream("cat " + VIDEO); OutputStream out = new FileOutputStream(file)) {
            copy(in, out);
        }
        if (file.length() == 0) fail("the test video " + VIDEO + " is missing or empty; push it with --other-files");
        return file;
    }

    // Shares `uri` to the app the way a gallery's share sheet would.
    void shareUri(Uri uri, String type) {
        log("sharing " + uri + " as " + type);
        // Go home first so the share arrives like it would from the gallery.
        device.pressHome();
        Intent send = new Intent(Intent.ACTION_SEND)
                .setClass(app, ShareRelayActivity.class)
                .setType(type)
                .putExtra(Intent.EXTRA_STREAM, uri)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        app.startActivity(send);
    }

    // Waits for the web app to show the shared video under `name`.
    void waitForShared(String name) {
        waitForShared(Pattern.compile(Pattern.quote(name)), name);
    }

    void waitForShared(Pattern name, String what) {
        waitFor(name, 120_000, "the web app to receive " + what);
        log("the web app received " + textOf(name));
        shot(what + "-shared");
    }

    void convert() {
        // Aim well below the test video's size so it really re-encodes.
        click(Pattern.compile("10 MB"));
        for (int mb = 10; mb > TARGET_MB; mb--) {
            click(Pattern.compile("Decrease target size|−"));
            SystemClock.sleep(200);
        }
        click(CONVERT);
        waitFor(Pattern.compile(PROGRESS.pattern() + "|" + DOWNLOAD.pattern()), 60_000, "the conversion to start");
        shot("converting");
    }

    String progress() {
        return textOf(PROGRESS);
    }

    // Waits for the conversion to finish, failing on an error, on no progress
    // for 90 seconds, or on the page sitting idle (a reload that lost it).
    void waitForResult(String when, boolean mayReload) {
        long end = SystemClock.uptimeMillis() + 5 * 60_000;
        long movedAt = SystemClock.uptimeMillis();
        long idleSince = 0;
        long lastLog = 0;
        String lastProgress = null;
        for (int poll = 0; ; poll++) {
            checkForError();
            if (findOnScreen(DOWNLOAD) != null) break;
            String progress = textOf(PROGRESS);
            long now = SystemClock.uptimeMillis();
            if (progress != null && !progress.equals(lastProgress)) {
                lastProgress = progress;
                movedAt = now;
            }
            if (now - movedAt > 90_000) {
                failWithScreen("the conversion " + when + " made no progress for 90 seconds (stuck at "
                        + (lastProgress == null ? "no progress" : lastProgress) + ")");
            }
            boolean idle = progress == null && findOnScreen(CONVERT) != null;
            idleSince = idle ? (idleSince == 0 ? now : idleSince) : 0;
            if (idleSince != 0 && now - idleSince > 60_000) {
                failWithScreen(mayReload
                        ? "the page reloaded in the background and the conversion did not resume"
                        : "the conversion stopped without a result");
            }
            if (now - lastLog > 30_000) {
                lastLog = now;
                log("still converting " + when + ": " + progress);
            }
            if (now > end) failWithScreen("timed out waiting for the conversion " + when + " to finish");
            // The result shows below the button, which may be off screen.
            if (poll % 5 == 4) scrollDown();
            SystemClock.sleep(2_000);
        }
        scrollDown();
        String engine = textOf(ENGINE);
        log("finished " + when + ": " + engine);
        shot("done");
        checkEngine(engine, when);
    }

    // The point of running on real phones: the conversion has to have gone
    // through WebCodecs, on a hardware encoder unless the run asks for less
    // (instrumentation argument engine=webcodecs, or engine=any).
    private void checkEngine(String engine, String when) {
        String wanted = InstrumentationRegistry.getArguments().getString("engine", "hardware");
        boolean ok;
        switch (wanted) {
            case "any":
                ok = true;
                break;
            case "webcodecs":
                ok = engine != null && engine.startsWith("WebCodecs");
                break;
            default:
                ok = "WebCodecs, hardware-accelerated".equals(engine);
                break;
        }
        if (!ok) {
            failWithScreen("the conversion " + when + " used " + (engine == null ? "an unknown engine" : "\"" + engine + "\"")
                    + ", not " + ("webcodecs".equals(wanted) ? "WebCodecs" : "hardware WebCodecs")
                    + " (engine=" + wanted + "); the app's console says why it fell back");
        }
    }

    // --- Finding things on screen ----------------------------------------

    // Chrome puts a web element's label in its accessibility node's text or
    // its content description, depending on the element and the version.
    UiObject2 findOnScreen(Pattern pattern) {
        UiObject2 found = device.findObject(By.text(pattern));
        return found != null ? found : device.findObject(By.desc(pattern));
    }

    // Like findOnScreen, but also scrolls to look for it. Only what's on
    // screen is in the accessibility tree.
    UiObject2 find(Pattern pattern) {
        UiObject2 found = findOnScreen(pattern);
        for (int i = 0; found == null && i < 4; i++) {
            scrollDown();
            found = findOnScreen(pattern);
        }
        for (int i = 0; found == null && i < 8; i++) {
            scrollUp();
            found = findOnScreen(pattern);
        }
        return found;
    }

    // Waits for `pattern` to show up, failing on an error message or timeout.
    void waitFor(Pattern pattern, long timeoutMs, String what) {
        long end = SystemClock.uptimeMillis() + timeoutMs;
        for (; ; ) {
            checkForError();
            UiObject2 found = SystemClock.uptimeMillis() < end - timeoutMs / 2 ? findOnScreen(pattern) : find(pattern);
            if (found != null) return;
            if (SystemClock.uptimeMillis() > end) failWithScreen("timed out waiting for " + what);
            SystemClock.sleep(1_000);
        }
    }

    // Waits for `pattern` without scrolling; null if it never showed.
    UiObject2 await(Pattern pattern, long timeoutMs) {
        long end = SystemClock.uptimeMillis() + timeoutMs;
        for (; ; ) {
            UiObject2 found = findOnScreen(pattern);
            if (found != null || SystemClock.uptimeMillis() > end) return found;
            SystemClock.sleep(1_000);
        }
    }

    void click(Pattern pattern) {
        UiObject2 target = find(pattern);
        if (target == null) failWithScreen("could not find \"" + pattern + "\" on screen");
        tap(target);
    }

    void tap(UiObject2 target) {
        Rect bounds = target.getVisibleBounds();
        device.click(bounds.centerX(), bounds.centerY());
    }

    private String textOf(Pattern pattern) {
        UiObject2 found = findOnScreen(pattern);
        if (found == null) return null;
        String text = found.getText();
        return text != null ? text : found.getContentDescription();
    }

    private void checkForError() {
        String error = textOf(ERROR);
        if (error != null) failWithScreen("the app showed an error: " + error);
    }

    private void scrollDown() {
        int w = device.getDisplayWidth(), h = device.getDisplayHeight();
        device.swipe(w / 2, h * 3 / 4, w / 2, h / 2, 20);
        SystemClock.sleep(300);
    }

    private void scrollUp() {
        int w = device.getDisplayWidth(), h = device.getDisplayHeight();
        device.swipe(w / 2, h / 2, w / 2, h * 3 / 4, 20);
        SystemClock.sleep(300);
    }

    // --- Reporting ---------------------------------------------------------

    Set<String> screenTexts() {
        Set<String> texts = new LinkedHashSet<>();
        try {
            ByteArrayOutputStream dump = new ByteArrayOutputStream();
            device.dumpWindowHierarchy(dump);
            Matcher m = Pattern.compile("(?:text|content-desc)=\"([^\"]+)\"").matcher(dump.toString("UTF-8"));
            while (m.find()) texts.add(m.group(1));
        } catch (IOException e) {
            texts.add("(could not read the screen: " + e + ")");
        }
        return texts;
    }

    void failWithScreen(String message) {
        shot("failure");
        Set<String> texts = screenTexts();
        log("FAIL: " + message);
        log("on screen: " + texts);
        fail(message + "\nOn screen: " + texts);
    }

    void step(String what) {
        log("=== " + what);
    }

    void log(String message) {
        Log.i(TAG, message);
    }

    void shot(String name) {
        shell(String.format("screencap -p %s/%02d-%s.png", SHOTS, ++shotCount, name.replaceAll("[^\\w.-]", "_")));
    }

    String versionOf(String pkg) {
        Matcher m = Pattern.compile("versionName=(\\S+)").matcher(shell("dumpsys package " + pkg));
        return m.find() ? m.group(1) : null;
    }

    // Runs a command as the shell user. There is no shell to parse it, so no
    // quoting, pipes or redirection.
    InputStream shellStream(String command) {
        ParcelFileDescriptor out = instrumentation.getUiAutomation().executeShellCommand(command);
        return new ParcelFileDescriptor.AutoCloseInputStream(out);
    }

    String shell(String command) {
        try (InputStream in = shellStream(command)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            copy(in, out);
            return out.toString(StandardCharsets.UTF_8.name());
        } catch (IOException e) {
            return "";
        }
    }

    static void copy(InputStream in, OutputStream out) throws IOException {
        byte[] buffer = new byte[64 * 1024];
        for (int n; (n = in.read(buffer)) > 0; ) out.write(buffer, 0, n);
    }
}
