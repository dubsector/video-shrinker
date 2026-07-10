package io.github.dubsector.videoshrinker;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.DialogInterface;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.view.ViewGroup;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import androidx.core.content.FileProvider;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Locale;

/**
 * Receives ACTION_SEND share intents and copies the shared video into this
 * app's cache before handing it to the Trusted Web Activity.
 *
 * The browser builds the share-target POST body by reading the sender's
 * content URI itself. When the video only exists in the sender's cloud
 * storage (e.g. a backed-up Google Photos item that is no longer on the
 * device), that read fails and the share dies with no useful feedback.
 * Reading the stream here instead makes the sender download the file on our
 * timeline, behind a visible progress dialog, and the browser then gets a
 * plain local file it can always read.
 *
 * NOTE: the SEND intent filters live on this activity in AndroidManifest.xml.
 * If `bubblewrap update` ever regenerates the manifest, the filters will move
 * back to LauncherActivity and this activity's declaration will be lost;
 * both need to be restored by hand afterwards.
 */
public class ShareRelayActivity extends Activity {

    private static final String CACHE_DIR_NAME = "shared_videos";
    private static final String FALLBACK_NAME = "shared-video.mp4";

    private volatile boolean cancelled;
    private boolean isResumedState;
    private ProgressBar progressBar;
    private TextView statusView;
    private AlertDialog dialog;
    private Intent pendingForward;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Uri source = extractUri(getIntent());
        if (source == null) {
            // Nothing to copy; let the TWA handle whatever this is.
            forward(new Intent(getIntent()));
            return;
        }

        buildDialog();
        copyInBackground(source);
    }

    private Uri extractUri(Intent intent) {
        String action = intent.getAction();
        if (Intent.ACTION_SEND.equals(action)) {
            return (Uri) intent.getParcelableExtra(Intent.EXTRA_STREAM);
        }
        if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Uri> uris = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            // The web app converts a single video at a time, so relay the first.
            return uris != null && !uris.isEmpty() ? uris.get(0) : null;
        }
        return null;
    }

    private void buildDialog() {
        int pad = (int) (24 * getResources().getDisplayMetrics().density);
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(pad, pad / 2, pad, 0);

        progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progressBar.setIndeterminate(true);
        progressBar.setMax(100);
        layout.addView(progressBar, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        statusView = new TextView(this);
        statusView.setPadding(0, pad / 4, 0, 0);
        statusView.setText(R.string.shareRelayStarting);
        layout.addView(statusView);

        dialog = new AlertDialog.Builder(this)
                .setTitle(R.string.shareRelayTitle)
                .setView(layout)
                .setCancelable(false)
                .setNegativeButton(android.R.string.cancel, new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface d, int which) {
                        cancelled = true;
                        finish();
                    }
                })
                .create();
        dialog.show();
    }

    private void copyInBackground(final Uri source) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    final Uri local = copyToCache(source);
                    if (cancelled) return;
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            if (cancelled) return;
                            Intent forward = new Intent();
                            forward.setAction(Intent.ACTION_SEND);
                            forward.setType(getIntent().getType() != null
                                    ? getIntent().getType() : "video/mp4");
                            forward.putExtra(Intent.EXTRA_STREAM, local);
                            forward.setClipData(ClipData.newRawUri(null, local));
                            forward.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                            forward(forward);
                        }
                    });
                } catch (final Exception e) {
                    if (cancelled) return;
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            showFailure(e.getMessage() != null
                                    ? e.getMessage() : e.getClass().getSimpleName());
                        }
                    });
                }
            }
        }).start();
    }

    private Uri copyToCache(Uri source) throws IOException {
        long total = -1;
        String name = FALLBACK_NAME;
        Cursor cursor = getContentResolver().query(source,
                new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null);
        if (cursor != null) {
            try {
                if (cursor.moveToFirst()) {
                    String displayName = cursor.getString(0);
                    if (displayName != null && !displayName.isEmpty()) {
                        name = displayName.replaceAll("[/\\\\]", "_");
                    }
                    if (!cursor.isNull(1)) total = cursor.getLong(1);
                }
            } finally {
                cursor.close();
            }
        }

        File dir = new File(getCacheDir(), CACHE_DIR_NAME);
        deleteContents(dir);
        if (!dir.isDirectory() && !dir.mkdirs()) {
            throw new IOException("Could not create the cache directory");
        }
        File out = new File(dir, name);

        InputStream in = getContentResolver().openInputStream(source);
        if (in == null) throw new IOException("The sharing app did not provide the video data");
        try {
            OutputStream os = new FileOutputStream(out);
            try {
                byte[] buffer = new byte[256 * 1024];
                long copied = 0;
                long lastUpdate = 0;
                int read;
                while ((read = in.read(buffer)) != -1) {
                    if (cancelled) {
                        out.delete();
                        throw new IOException("Cancelled");
                    }
                    os.write(buffer, 0, read);
                    copied += read;
                    long now = System.currentTimeMillis();
                    if (now - lastUpdate >= 250) {
                        lastUpdate = now;
                        publishProgress(copied, total);
                    }
                }
            } finally {
                os.close();
            }
        } catch (IOException e) {
            out.delete();
            throw e;
        } finally {
            in.close();
        }

        return FileProvider.getUriForFile(this, getString(R.string.providerAuthority), out);
    }

    private static void deleteContents(File dir) {
        File[] children = dir.listFiles();
        if (children == null) return;
        for (File child : children) {
            child.delete();
        }
    }

    private void publishProgress(final long copied, final long total) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (isFinishing() || cancelled) return;
                if (total > 0) {
                    progressBar.setIndeterminate(false);
                    progressBar.setProgress((int) (copied * 100 / total));
                    statusView.setText(String.format(Locale.US, "%s / %s",
                            formatMb(copied), formatMb(total)));
                } else {
                    statusView.setText(String.format(Locale.US, "%s received", formatMb(copied)));
                }
            }
        });
    }

    private static String formatMb(long bytes) {
        return String.format(Locale.US, "%.0f MB", bytes / (1024.0 * 1024.0));
    }

    private void showFailure(String message) {
        if (isFinishing()) return;
        progressBar.setIndeterminate(false);
        progressBar.setProgress(0);
        statusView.setText(getString(R.string.shareRelayFailed, message));
        if (dialog != null && dialog.getButton(DialogInterface.BUTTON_NEGATIVE) != null) {
            dialog.getButton(DialogInterface.BUTTON_NEGATIVE).setText(android.R.string.ok);
        }
    }

    /**
     * Launches LauncherActivity with the relayed share. Starting an activity
     * from the background is restricted on Android 10+, so if the user left
     * mid-copy the forward is held until this activity is visible again.
     */
    private void forward(Intent forward) {
        forward.setClass(this, LauncherActivity.class);
        if (isResumedState) {
            startActivity(forward);
            finish();
        } else {
            pendingForward = forward;
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        isResumedState = true;
        if (pendingForward != null) {
            Intent forward = pendingForward;
            pendingForward = null;
            startActivity(forward);
            finish();
        }
    }

    @Override
    protected void onPause() {
        isResumedState = false;
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (isFinishing()) cancelled = true;
        if (dialog != null) dialog.dismiss();
        super.onDestroy();
    }
}
