package io.github.dubsector.videoshrinker;

import static org.junit.Assume.assumeTrue;

import android.content.ClipData;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import android.provider.OpenableColumns;

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
import java.io.OutputStream;
import java.util.regex.Pattern;

/**
 * Shares a video to the app from the places real shares come from, and
 * checks the web app receives it each time. The failure seen on phones is
 * the app opening with nothing attached and no error; WebApp.waitForShared
 * names that case when it happens. The emulator test can't do this:
 * its shell can't grant another app a gallery item, so it only ever shares
 * from the app's own files.
 *
 *  - fromGallery: an item in the system's media store (content://media/...).
 *  - fromPhotosLikeApp: another app sharing from its own task, its provider
 *    behaving like Google Photos at its most awkward: no extension, size or
 *    type, streaming slowly. Then again with Chrome not running.
 *  - fromGooglePhotos: Google Photos itself, through its Share button, where
 *    the phone has it. Skipped when Photos isn't there or its screens can't
 *    be got through, since that says nothing about the app.
 */
@RunWith(AndroidJUnit4.class)
public class ShareSourcesTest {

    private static final String PHOTOS = "com.google.android.apps.photos";
    private static final Pattern SHARE_TARGET = Pattern.compile("Vid Shrinker|Video Shrinker");

    private WebApp web;
    private Uri galleryItem;

    @Before
    public void setUp() {
        web = new WebApp();
        web.start();
    }

    @After
    public void tearDown() {
        if (galleryItem != null) web.app.getContentResolver().delete(galleryItem, null, null);
    }

    @Test
    public void fromGallery() throws IOException {
        assumeTrue("adding to the media store without a permission needs Android 10",
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q);
        web.step("Sharing a video from the media store");
        String name = addToGallery();
        web.shareUri(galleryItem, "video/mp4");
        web.waitForShared(name);
    }

    @Test
    public void fromPhotosLikeApp() throws IOException {
        web.step("Sharing a video like Google Photos does, from its own task");
        shareLikePhotos("PXL_20261004_120000123");
    }

    @Test
    public void fromPhotosLikeAppWithChromeStopped() throws IOException {
        web.step("Sharing a video like Google Photos does, with Chrome not running");
        web.device.pressHome();
        web.shell("am force-stop " + WebApp.CHROME);
        shareLikePhotos("PXL_20261004_120500456");
    }

    @Test
    public void fromGooglePhotos() throws IOException {
        assumeTrue("adding to the media store without a permission needs Android 10",
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q);
        String photos = web.versionOf(PHOTOS);
        assumeTrue("Google Photos is not installed", photos != null);
        web.step("Sharing a video from Google Photos " + photos);
        String name = addToGallery();
        web.device.pressHome();
        Intent view = new Intent(Intent.ACTION_VIEW)
                .setDataAndType(galleryItem, "video/mp4")
                .setPackage(PHOTOS)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK
                        | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        web.app.startActivity(view);

        UiObject2 share = web.await(Pattern.compile("Share"), 30_000);
        if (share == null) {
            // The viewer hides its buttons until tapped.
            web.device.click(web.device.getDisplayWidth() / 2, web.device.getDisplayHeight() / 2);
            share = web.await(Pattern.compile("Share"), 10_000);
        }
        skipUnless(share != null, "Google Photos showed no Share button");
        web.shot("photos-viewer");
        web.tap(share);

        // Photos lists apps in its own sheet, or hands over to Android's.
        UiObject2 target = web.await(SHARE_TARGET, 15_000);
        for (int i = 0; target == null && i < 3; i++) {
            UiObject2 more = web.findOnScreen(Pattern.compile("More|More options|More apps"));
            if (more != null) {
                web.tap(more);
            } else {
                int w = web.device.getDisplayWidth(), h = web.device.getDisplayHeight();
                web.device.swipe(w / 2, h * 3 / 4, w / 2, h / 3, 20);
            }
            target = web.await(SHARE_TARGET, 5_000);
        }
        skipUnless(target != null, "could not find the app in Google Photos' share sheet");
        web.shot("photos-share-sheet");
        web.tap(target);
        // Photos may share under its own name for the item; the relay keeps
        // or adds the extension.
        String base = name.substring(0, name.lastIndexOf('.'));
        web.waitForShared(Pattern.compile(Pattern.quote(base) + "(\\.\\w+)?"), base);
    }

    // Shares the test video from another app's task and provider the way
    // Google Photos can at its most awkward: a Pixel camera name with no
    // extension, no size, no type, and a slow unseekable stream, as when
    // Photos downloads a cloud-only item. The relay should add the extension
    // for the real type.
    private void shareLikePhotos(String name) throws IOException {
        File file = web.copyVideoToApp(PhotosLikeProvider.SOURCE_NAME);
        String testPackage = web.instrumentation.getContext().getPackageName();
        Uri source = FileProvider.getUriForFile(web.app, web.app.getPackageName() + ".fileprovider", file);
        web.app.grantUriPermission(testPackage, source, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        // About 12 seconds for the 12 MB test video, so the relay's
        // "Preparing your video" dialog shows for a while.
        Uri uri = new Uri.Builder()
                .scheme(ContentResolver.SCHEME_CONTENT)
                .authority(testPackage + ".photoslike")
                .appendPath(name)
                .appendQueryParameter("kbps", "1024")
                .build();
        // Photos shares with a wildcard type when the item's is unknown.
        Intent share = new Intent(Intent.ACTION_SEND)
                .setClassName(web.app, ShareRelayActivity.class.getName())
                .setType("video/*")
                .putExtra(Intent.EXTRA_STREAM, uri)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        share.setClipData(ClipData.newRawUri(null, uri));
        web.log("sharing " + uri + " from another app's task");
        web.device.pressHome();
        web.app.startActivity(new Intent()
                .setClassName(testPackage, SenderActivity.class.getName())
                .putExtra(SenderActivity.EXTRA_SHARE, share)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        web.waitForShared(name + ".mp4");
    }

    // Adds the test video to the media store as a new item and returns its
    // display name.
    private String addToGallery() throws IOException {
        ContentResolver resolver = web.app.getContentResolver();
        ContentValues values = new ContentValues();
        values.put(MediaStore.Video.Media.DISPLAY_NAME, "VID_" + System.currentTimeMillis() + ".mp4");
        values.put(MediaStore.Video.Media.MIME_TYPE, "video/mp4");
        values.put(MediaStore.Video.Media.RELATIVE_PATH, "Movies/Video Shrinker test");
        values.put(MediaStore.Video.Media.IS_PENDING, 1);
        galleryItem = resolver.insert(MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), values);
        if (galleryItem == null) throw new IOException("the media store would not take the video");
        try (InputStream in = web.shellStream("cat " + WebApp.VIDEO);
             OutputStream out = resolver.openOutputStream(galleryItem)) {
            if (out == null) throw new IOException("could not write " + galleryItem);
            WebApp.copy(in, out);
        }
        values.clear();
        values.put(MediaStore.Video.Media.IS_PENDING, 0);
        resolver.update(galleryItem, values, null, null);
        // The media store may have renamed it to avoid a clash.
        try (Cursor c = resolver.query(galleryItem, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c == null || !c.moveToFirst()) throw new IOException("could not read back " + galleryItem);
            String name = c.getString(0);
            web.log("added " + galleryItem + " as " + name);
            return name;
        }
    }

    private void skipUnless(boolean ok, String why) {
        if (!ok) web.log("skipping: " + why + "; on screen: " + web.screenTexts());
        assumeTrue(why, ok);
    }
}
