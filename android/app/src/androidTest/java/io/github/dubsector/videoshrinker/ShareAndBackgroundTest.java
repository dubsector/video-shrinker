package io.github.dubsector.videoshrinker;

import static org.junit.Assert.fail;

import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.graphics.Rect;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
import android.util.Log;

import androidx.core.content.FileProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.By;
import androidx.test.uiautomator.UiDevice;
import androidx.test.uiautomator.UiObject2;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

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
 * The emulator smoke test (android/emulator-test/smoke-test.sh), rewritten to
 * run on Firebase Test Lab devices, where there is no adb to drive Chrome over
 * DevTools. It drives the web app through Chrome's accessibility tree instead:
 *   1. launches the app and waits for the web app to render,
 *   2. shares a video to it and converts it with the app kept in front,
 *   3. shares it again, converts it and sends the app to the background
 *      mid-encode, then checks the conversion still finishes.
 *
 * The device locale must be English, since it finds the page's controls by
 * their English labels. The test video and Chrome's command line are pushed
 * to /data/local/tmp by the test run (see .github/workflows/firebase-test-lab.yml).
 * Screenshots go to /sdcard/test-lab; what was seen is logged under the
 * TestLabSmoke tag.
 *
 * Each conversion must have used WebCodecs on a hardware encoder: that is
 * what the emulator can't test, since it has none and the app falls back to
 * ffmpeg.wasm there. The instrumentation argument engine=webcodecs also
 * accepts WebCodecs' software encoder, and engine=any accepts anything.
 */
@RunWith(AndroidJUnit4.class)
public class ShareAndBackgroundTest {

    private static final String TAG = "TestLabSmoke";
    private static final String CHROME = "com.android.chrome";
    private static final String VIDEO = "/data/local/tmp/smoke-test.mp4";
    private static final String SHOTS = "/sdcard/test-lab";
    private static final int TARGET_MB = 2;

    private static final Pattern CONVERT = Pattern.compile("Convert");
    private static final Pattern DOWNLOAD = Pattern.compile("Download");
    private static final Pattern PROGRESS = Pattern.compile("(Paused · )?\\d+%");
    private static final Pattern ENGINE = Pattern.compile(
            "WebCodecs, hardware-accelerated|WebCodecs, software encoder|ffmpeg\\.wasm, CPU fallback"
                    + "|Left as-is, nothing to shrink|Metadata stripped, video left untouched"
                    + "|This footage doesn't compress below its current size.*");
    // Everything the app shows in its error box (src/locales/en.json, errors).
    private static final Pattern ERROR = Pattern.compile(
            "Please choose a video file\\.|Conversion failed\\..*|Gave up waiting for the shared video\\..*"
                    + "|The shared video never arrived from the system\\..*|Could not receive the shared video.*");

    private Instrumentation instrumentation;
    private Context app;
    private UiDevice device;
    private int shotCount;

    @Before
    public void setUp() throws IOException {
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
        log("Chrome " + chromeVersion() + ", Android " + android.os.Build.VERSION.RELEASE
                + ", " + android.os.Build.MANUFACTURER + " " + android.os.Build.MODEL);
    }

    @Test
    public void shareConvertAndBackground() throws IOException {
        step("Launching the app");
        launch(true);
        waitFor(CONVERT, 90_000, "the web app to render");
        // The share target is handled by the service worker, so a share sent
        // before it controls the page would be lost. There is no way to see
        // that from here, so give a first load time to install it.
        SystemClock.sleep(10_000);
        shot("launched");

        step("Sharing a video and converting it with the app kept in front");
        share("stay.mp4");
        convert();
        waitForResult("with the app in front", false);

        step("Sharing it again and converting it with the app sent to the background mid-encode");
        share("leave.mp4");
        convert();
        // Let it get going before leaving.
        SystemClock.sleep(5_000);
        log("progress before backgrounding: " + textOf(PROGRESS));
        device.pressHome();
        SystemClock.sleep(20_000);
        shot("background");
        launch(false);
        waitForResult("after backgrounding", true);
        log("PASS");
    }

    // Shares the test video to the app as `name` and waits for the web app to
    // show it. Each share uses a new name, so it can't be mistaken for the
    // video already on screen.
    private void share(String name) throws IOException {
        // Like the emulator test, serve the video from the app's own
        // FileProvider. The relay still reads it through a content URI and
        // copies it, as it would from the gallery.
        File dir = new File(app.getFilesDir(), "twa_splash");
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("could not create " + dir);
        File file = new File(dir, name);
        try (InputStream in = shellStream("cat " + VIDEO); OutputStream out = new FileOutputStream(file)) {
            byte[] buffer = new byte[64 * 1024];
            for (int n; (n = in.read(buffer)) > 0; ) out.write(buffer, 0, n);
        }
        if (file.length() == 0) fail("the test video " + VIDEO + " is missing or empty; push it with --other-files");
        Uri uri = FileProvider.getUriForFile(app, app.getPackageName() + ".fileprovider", file);
        log("sharing " + uri + " (" + file.length() + " bytes)");
        // Go home first so the share arrives like it would from the gallery.
        device.pressHome();
        Intent send = new Intent(Intent.ACTION_SEND)
                .setClass(app, ShareRelayActivity.class)
                .setType("video/mp4")
                .putExtra(Intent.EXTRA_STREAM, uri)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        app.startActivity(send);
        waitFor(Pattern.compile(Pattern.quote(name)), 120_000, "the web app to receive " + name);
        shot(name + "-shared");
    }

    private void convert() {
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

    // Waits for the conversion to finish, failing on an error, on no progress
    // for 90 seconds, or on the page sitting idle (a reload that lost it).
    private void waitForResult(String when, boolean mayReload) {
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

    private void launch(boolean fresh) {
        Intent launch = app.getPackageManager().getLaunchIntentForPackage(app.getPackageName());
        if (launch == null) fail("the app has no launcher activity");
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | (fresh ? Intent.FLAG_ACTIVITY_CLEAR_TASK : 0));
        app.startActivity(launch);
    }

    // --- Finding things on the page --------------------------------------

    // Chrome puts a web element's label in its accessibility node's text or
    // its content description, depending on the element and the version.
    private UiObject2 findOnScreen(Pattern pattern) {
        UiObject2 found = device.findObject(By.text(pattern));
        return found != null ? found : device.findObject(By.desc(pattern));
    }

    // Like findOnScreen, but also scrolls the page to look for it. Only
    // what's on screen is in the accessibility tree.
    private UiObject2 find(Pattern pattern) {
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

    private void waitFor(Pattern pattern, long timeoutMs, String what) {
        long end = SystemClock.uptimeMillis() + timeoutMs;
        for (; ; ) {
            checkForError();
            UiObject2 found = SystemClock.uptimeMillis() < end - timeoutMs / 2 ? findOnScreen(pattern) : find(pattern);
            if (found != null) return;
            if (SystemClock.uptimeMillis() > end) failWithScreen("timed out waiting for " + what);
            SystemClock.sleep(1_000);
        }
    }

    private void click(Pattern pattern) {
        UiObject2 target = find(pattern);
        if (target == null) failWithScreen("could not find \"" + pattern + "\" on the page");
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

    private void failWithScreen(String message) {
        shot("failure");
        Set<String> texts = new LinkedHashSet<>();
        try {
            ByteArrayOutputStream dump = new ByteArrayOutputStream();
            device.dumpWindowHierarchy(dump);
            Matcher m = Pattern.compile("(?:text|content-desc)=\"([^\"]+)\"").matcher(dump.toString("UTF-8"));
            while (m.find()) texts.add(m.group(1));
        } catch (IOException e) {
            texts.add("(could not read the screen: " + e + ")");
        }
        log("FAIL: " + message);
        log("on screen: " + texts);
        fail(message + "\nOn screen: " + texts);
    }

    private void step(String what) {
        log("=== " + what);
    }

    private void log(String message) {
        Log.i(TAG, message);
    }

    private void shot(String name) {
        shell(String.format("screencap -p %s/%02d-%s.png", SHOTS, ++shotCount, name));
    }

    private String chromeVersion() {
        Matcher m = Pattern.compile("versionName=(\\S+)").matcher(shell("dumpsys package " + CHROME));
        return m.find() ? m.group(1) : "not installed";
    }

    // Runs a command as the shell user. There is no shell to parse it, so no
    // quoting, pipes or redirection.
    private InputStream shellStream(String command) {
        ParcelFileDescriptor out = instrumentation.getUiAutomation().executeShellCommand(command);
        return new ParcelFileDescriptor.AutoCloseInputStream(out);
    }

    private String shell(String command) {
        try (InputStream in = shellStream(command)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            for (int n; (n = in.read(buffer)) > 0; ) out.write(buffer, 0, n);
            return out.toString(StandardCharsets.UTF_8.name());
        } catch (IOException e) {
            return "";
        }
    }
}
