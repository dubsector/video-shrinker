package io.github.dubsector.videoshrinker;

import android.net.Uri;
import android.os.SystemClock;

import androidx.core.content.FileProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;

import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.File;
import java.io.IOException;

/**
 * The emulator smoke test (android/emulator-test/smoke-test.sh) on a real
 * phone: share a video in and convert it with the app kept in front, then
 * again with the app sent to the background mid-encode.
 *
 * Each conversion must have used WebCodecs on a hardware encoder: that is
 * what the emulator can't test, since it has none and the app falls back to
 * ffmpeg.wasm there. The instrumentation argument engine=webcodecs also
 * accepts WebCodecs' software encoder, and engine=any accepts anything.
 */
@RunWith(AndroidJUnit4.class)
public class ShareAndBackgroundTest {

    @Test
    public void shareConvertAndBackground() throws IOException {
        WebApp web = new WebApp();
        web.step("Launching the app");
        web.start();

        web.step("Sharing a video and converting it with the app kept in front");
        share(web, "stay.mp4");
        web.convert();
        web.waitForResult("with the app in front", false);

        web.step("Sharing it again and converting it with the app sent to the background mid-encode");
        share(web, "leave.mp4");
        web.convert();
        // Let it get going before leaving.
        SystemClock.sleep(5_000);
        web.log("progress before backgrounding: " + web.progress());
        web.device.pressHome();
        SystemClock.sleep(20_000);
        web.shot("background");
        web.launch(false);
        web.waitForResult("after backgrounding", true);
        web.log("PASS");
    }

    // Each share uses a new name, so it can't be mistaken for the video
    // already on screen.
    private static void share(WebApp web, String name) throws IOException {
        File file = web.copyVideoToApp(name);
        Uri uri = FileProvider.getUriForFile(web.app, web.app.getPackageName() + ".fileprovider", file);
        web.shareUri(uri, "video/mp4");
        web.waitForShared(name);
    }
}
