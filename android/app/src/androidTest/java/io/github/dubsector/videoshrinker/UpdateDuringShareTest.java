package io.github.dubsector.videoshrinker;

import android.net.Uri;
import android.os.SystemClock;

import androidx.core.content.FileProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.uiautomator.UiObject2;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.util.regex.Pattern;

/**
 * Shares a video into the app while a new version of the web app comes out,
 * on a real phone. The web app updates itself with a quiet reload whenever it
 * has nothing worth keeping, and coming back to it from a share is exactly
 * when it looks for an update, so a reload at the wrong moment loses the
 * share without a word.
 *
 * Test Lab's phones load the live site, which can't be given a new version on
 * cue, so this test serves the branch's own build from the phone (LocalSite)
 * and points Chrome at it, then releases a new version when it needs one.
 */
@RunWith(AndroidJUnit4.class)
public class UpdateDuringShareTest {

    private static final String SITE_ZIP = "/data/local/tmp/site.zip";
    private static final String SITE_KEYS = "/data/local/tmp/site-cert.p12";
    private static final String FLAGS = "/data/local/tmp/chrome-command-line";
    private static final Pattern RELOAD_TO_UPDATE = Pattern.compile("Reload to update");

    private WebApp web;
    private LocalSite site;

    @Before
    public void setUp() throws Exception {
        web = new WebApp();
        // Start Chrome afresh, with no copy of the live site's service worker,
        // and with the flags that send dubsector.github.io to LocalSite.
        web.shell("pm clear " + WebApp.CHROME);
        web.shell("cp " + FLAGS + "-local " + FLAGS);
        try (InputStream zip = web.shellStream("cat " + SITE_ZIP);
             InputStream keys = web.shellStream("cat " + SITE_KEYS)) {
            site = new LocalSite(web.app.getCacheDir(), zip, keys, "test".toCharArray());
        } catch (IOException e) {
            throw new IOException("could not serve the site from " + SITE_ZIP + " (run-firebase-test.sh pushes it): " + e, e);
        }
    }

    @After
    public void tearDown() {
        if (site != null) site.stop();
        // Leave Chrome as the other tests expect it: on the live site, with
        // nothing of this test's local copy left behind.
        web.shell("cp " + FLAGS + "-live " + FLAGS);
        web.shell("pm clear " + WebApp.CHROME);
    }

    @Test
    public void newVersionJustBeforeShare() throws IOException {
        web.step("Loading the app from the phone itself");
        web.start();
        web.step("Releasing a new version of the app, then sharing a video");
        site.release(2);
        share("before-update.mp4");
        keepsVideo("before-update.mp4");
    }

    @Test
    public void newVersionAfterShare() throws IOException {
        web.step("Loading the app from the phone itself and sharing a video");
        web.start();
        share("after-update.mp4");
        web.step("Releasing a new version, and coming back to the app, which then looks for it");
        site.release(2);
        web.device.pressHome();
        SystemClock.sleep(3_000);
        web.launch(false);
        keepsVideo("after-update.mp4");
        // With a video loaded the app should ask before updating.
        UiObject2 reload = web.await(RELOAD_TO_UPDATE, 30_000);
        if (reload == null) web.failWithScreen("the app never offered the new version, so the update wasn't tested");
        web.step("Taking the update");
        web.tap(reload);
        SystemClock.sleep(10_000);
        web.waitFor(Pattern.compile(Pattern.quote("after-update.mp4")), 60_000,
                "the shared video to still be there after updating");
        web.log("the shared video was still there after updating");
    }

    private void share(String name) throws IOException {
        File file = web.copyVideoToApp(name);
        Uri uri = FileProvider.getUriForFile(web.app, web.app.getPackageName() + ".fileprovider", file);
        web.shareUri(uri, "video/mp4");
        web.waitForShared(name);
    }

    // Gives any reload the update might cause time to happen, then checks
    // the shared video is still on screen.
    private void keepsVideo(String name) {
        SystemClock.sleep(15_000);
        web.waitFor(Pattern.compile(Pattern.quote(name)), 15_000,
                "the shared video to still be there once the new version was out");
        web.log("the shared video was still there once the new version was out");
    }
}
