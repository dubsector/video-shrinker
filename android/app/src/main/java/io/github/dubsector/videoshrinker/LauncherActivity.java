/*
 * Copyright 2020 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package io.github.dubsector.videoshrinker;

import android.content.ClipData;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;

import androidx.browser.trusted.TrustedWebActivityIntentBuilder;
import androidx.browser.trusted.sharing.ShareData;

import java.util.List;

public class LauncherActivity
        extends com.google.androidbrowserhelper.trusted.LauncherActivity {
    

    

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Setting an orientation crashes the app due to the transparent background on Android 8.0
        // Oreo and below. We only set the orientation on Oreo and above. This only affects the
        // splash screen and Chrome will still respect the orientation.
        // See https://github.com/GoogleChromeLabs/bubblewrap/issues/496 for details.
        if (Build.VERSION.SDK_INT > Build.VERSION_CODES.O) {
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
        } else {
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
        }
    }

    @Override
    protected Uri getLaunchingUrl() {
        // Get the original launch Url.
        Uri uri = super.getLaunchingUrl();

        

        return uri;
    }

    /**
     * Chrome 153 and later only hand a shared file to the web app when the
     * app that launched the Trusted Web Activity could read it at launch.
     * On Android 15+ it asks Android, which can only answer for files named
     * in the launch intent's EXTRA_STREAM or ClipData. The share library
     * passes them only inside its own share-data bundle, so Chrome counted
     * every relayed video as unreadable and posted the share with no file
     * at all ("No video found ... [received nothing]"). Name them in the
     * launch intent too.
     */
    @Override
    public void startActivity(Intent intent, Bundle options) {
        exposeSharedFiles(intent);
        super.startActivity(intent, options);
    }

    private static void exposeSharedFiles(Intent intent) {
        Bundle bundle = intent.getBundleExtra(TrustedWebActivityIntentBuilder.EXTRA_SHARE_DATA);
        if (bundle == null) return;
        List<Uri> uris = ShareData.fromBundle(bundle).uris;
        if (uris == null || uris.isEmpty()) return;
        ClipData clip = ClipData.newRawUri(null, uris.get(0));
        for (int i = 1; i < uris.size(); i++) clip.addItem(new ClipData.Item(uris.get(i)));
        intent.setClipData(clip);
        intent.putExtra(Intent.EXTRA_STREAM, uris.get(0));
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
    }
}
