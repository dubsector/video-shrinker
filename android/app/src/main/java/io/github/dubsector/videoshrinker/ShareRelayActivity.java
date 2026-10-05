package io.github.dubsector.videoshrinker;

import android.app.Activity;
import android.app.Dialog;
import android.content.ClipData;
import android.content.Intent;
import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.database.Cursor;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.MimeTypeMap;
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
    private static final String FALLBACK_NAME = "shared-video";
    private static final String FALLBACK_TYPE = "video/mp4";

    private volatile boolean cancelled;
    // Concrete MIME type of the copied video, set by copyToCache().
    private volatile String resolvedType = FALLBACK_TYPE;
    private boolean isResumedState;
    private ProgressBar spinner;
    private TextView statusView;
    private TextView actionButton;
    private Dialog dialog;
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

    /**
     * The shared item to relay. Most senders put it in EXTRA_STREAM, but
     * some only fill in the ClipData, and a multi-item share may lead with
     * something that isn't a video. Missing it here forwarded the share
     * untouched, so the web app opened with "No video found".
     */
    private Uri extractUri(Intent intent) {
        String action = intent.getAction();
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            return null;
        }
        ArrayList<Uri> candidates = new ArrayList<>();
        try {
            if (Intent.ACTION_SEND.equals(action)) {
                Uri uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
                if (uri != null) candidates.add(uri);
            } else {
                ArrayList<Uri> uris = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
                if (uris != null) candidates.addAll(uris);
            }
        } catch (RuntimeException ignored) {
            // A sender put something other than a Uri under EXTRA_STREAM.
        }
        ClipData clip = intent.getClipData();
        if (clip != null) {
            for (int i = 0; i < clip.getItemCount(); i++) {
                Uri uri = clip.getItemAt(i).getUri();
                if (uri != null && !candidates.contains(uri)) candidates.add(uri);
            }
        }
        // The web app converts a single video at a time, so relay the first
        // video, or the first item when none says what it is.
        for (Uri uri : candidates) {
            String type = null;
            try {
                type = getContentResolver().getType(uri);
            } catch (Exception ignored) {
                // Some providers throw instead of returning null.
            }
            if (type != null && type.toLowerCase(Locale.ROOT).startsWith("video/")) return uri;
        }
        return candidates.isEmpty() ? null : candidates.get(0);
    }

    /**
     * Builds the preparing dialog in code, styled after the system media
     * picker's "Preparing your selected media" dialog (and the web app's
     * copy of it): rounded surface, arc spinner beside a status line, and
     * a text-button Cancel action. The framework AlertDialog is avoided
     * because the activity's translucent theme renders it in the ancient
     * pre-Material style.
     */
    private void buildDialog() {
        boolean night = (getResources().getConfiguration().uiMode
                & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        int surface = night ? 0xFF23242D : 0xFFFFFFFF;
        int titleColor = night ? 0xFFF3F4F6 : 0xFF08060D;
        int statusColor = night ? 0xFF9CA3AF : 0xFF6B6375;
        int accent = 0xFF5865F2;

        dialog = new Dialog(this, night
                ? android.R.style.Theme_Material_Dialog_NoActionBar
                : android.R.style.Theme_Material_Light_Dialog_NoActionBar);

        LinearLayout layout = new LinearLayout(dialog.getContext());
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(dp(24), dp(24), dp(24), dp(14));

        TextView title = new TextView(dialog.getContext());
        title.setText(R.string.shareRelayTitle);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
        title.setTextColor(titleColor);
        layout.addView(title);

        LinearLayout statusRow = new LinearLayout(dialog.getContext());
        statusRow.setOrientation(LinearLayout.HORIZONTAL);
        statusRow.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout.LayoutParams rowParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        rowParams.topMargin = dp(20);
        layout.addView(statusRow, rowParams);

        spinner = new ProgressBar(dialog.getContext());
        spinner.setIndeterminate(true);
        spinner.setIndeterminateTintList(ColorStateList.valueOf(accent));
        LinearLayout.LayoutParams spinnerParams = new LinearLayout.LayoutParams(dp(30), dp(30));
        spinnerParams.rightMargin = dp(16);
        statusRow.addView(spinner, spinnerParams);

        statusView = new TextView(dialog.getContext());
        statusView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        statusView.setTextColor(statusColor);
        statusView.setText(R.string.shareRelayStarting);
        statusRow.addView(statusView);

        actionButton = new TextView(dialog.getContext());
        actionButton.setText(android.R.string.cancel);
        actionButton.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        actionButton.setTextColor(accent);
        actionButton.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        actionButton.setPadding(dp(14), dp(10), dp(14), dp(10));
        TypedValue ripple = new TypedValue();
        if (dialog.getContext().getTheme().resolveAttribute(
                android.R.attr.selectableItemBackgroundBorderless, ripple, true)) {
            actionButton.setBackgroundResource(ripple.resourceId);
        }
        actionButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                cancelled = true;
                finish();
            }
        });
        LinearLayout.LayoutParams buttonParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        buttonParams.gravity = Gravity.END;
        buttonParams.topMargin = dp(10);
        buttonParams.rightMargin = -dp(14);
        layout.addView(actionButton, buttonParams);

        GradientDrawable background = new GradientDrawable();
        background.setColor(surface);
        background.setCornerRadius(dp(28));

        dialog.setContentView(layout);
        dialog.setCancelable(false);
        dialog.getWindow().setBackgroundDrawable(background);
        int width = Math.min(dp(340),
                getResources().getDisplayMetrics().widthPixels - dp(48));
        dialog.getWindow().setLayout(width, WindowManager.LayoutParams.WRAP_CONTENT);
        dialog.show();
    }

    private int dp(int value) {
        return (int) (value * getResources().getDisplayMetrics().density + 0.5f);
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
                            forward.setType(resolvedType);
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

        // Chrome learns the file's type from FileProvider, which only looks at
        // the extension, and drops any file whose type is not in the share
        // target's accept list. Senders like Google Photos sometimes report a
        // display name with no extension (or none at all), so the relayed file
        // reached the web app as application/octet-stream and the share
        // failed with "No video found". Name the copy after its real type.
        String type = resolveVideoType(source);
        resolvedType = type;
        name = withExtensionFor(name, type);

        File dir = new File(getCacheDir(), CACHE_DIR_NAME);
        deleteContents(dir);
        if (!dir.isDirectory() && !dir.mkdirs()) {
            throw new IOException("Could not create the cache directory");
        }
        File out = new File(dir, name);

        // A sender can hand over a stream that ends early, or at once, with
        // no error: forwarding that short file let the browser drop it and
        // the web app open with "No video found". Read it again a couple of
        // times, then say what happened instead.
        long copied = 0;
        for (int attempt = 1; ; attempt++) {
            copied = copyOnce(source, out, total);
            boolean complete = copied > 0 && (total <= 0 || copied >= total);
            if (complete) break;
            if (attempt == 3) {
                out.delete();
                throw new IOException(total > 0
                        ? String.format(Locale.US, "the sharing app sent %s of %s",
                                formatMb(copied), formatMb(total))
                        : "the sharing app sent no video data");
            }
            try {
                Thread.sleep(1500);
            } catch (InterruptedException e) {
                throw new IOException("Interrupted");
            }
        }

        return FileProvider.getUriForFile(this, getString(R.string.providerAuthority), out);
    }

    /** Copies {@code source} to {@code out}, returning how many bytes came. */
    private long copyOnce(Uri source, File out, long total) throws IOException {
        InputStream in = getContentResolver().openInputStream(source);
        if (in == null) throw new IOException("The sharing app did not provide the video data");
        long copied = 0;
        try {
            OutputStream os = new FileOutputStream(out);
            try {
                byte[] buffer = new byte[256 * 1024];
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
        return copied;
    }

    /**
     * The most specific video MIME type available for the shared item: the
     * provider's own answer first, then the share intent's type, ignoring
     * wildcards and generic types that FileProvider could not map back.
     */
    private String resolveVideoType(Uri source) {
        String type = null;
        try {
            type = getContentResolver().getType(source);
        } catch (Exception ignored) {
            // Some providers throw instead of returning null.
        }
        if (!isConcreteVideoType(type)) type = getIntent().getType();
        if (!isConcreteVideoType(type)) type = FALLBACK_TYPE;
        return type.toLowerCase(Locale.ROOT);
    }

    private static boolean isConcreteVideoType(String type) {
        return type != null && type.toLowerCase(Locale.ROOT).startsWith("video/")
                && !type.endsWith("/*");
    }

    /**
     * Makes sure the name ends in an extension FileProvider maps to a video
     * type, appending one for {@code type} when it doesn't.
     */
    private static String withExtensionFor(String name, String type) {
        MimeTypeMap map = MimeTypeMap.getSingleton();
        int dot = name.lastIndexOf('.');
        if (dot > 0 && dot < name.length() - 1) {
            String ext = name.substring(dot + 1).toLowerCase(Locale.ROOT);
            String extType = map.getMimeTypeFromExtension(ext);
            if (extType != null && extType.startsWith("video/")) {
                // Lower-case the extension: older Android versions match it
                // case-sensitively, so "clip.MP4" would come out untyped.
                return name.substring(0, dot + 1) + ext;
            }
        }
        String ext = map.getExtensionFromMimeType(type);
        if (ext == null) ext = "mp4";
        return name + "." + ext;
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
        spinner.setVisibility(View.GONE);
        statusView.setText(getString(R.string.shareRelayFailed, message));
        actionButton.setText(android.R.string.ok);
    }

    /**
     * Launches LauncherActivity with the relayed share. Starting an activity
     * from the background is restricted on Android 10+, so if the user left
     * mid-copy the forward is held until this activity is visible again.
     *
     * NEW_TASK and CLEAR_TOP make sure the share is delivered when the app
     * is already open. Without them LauncherActivity restarts itself with
     * NEW_TASK alone, and if the open app's task was itself started by a
     * share (its root intent SEND of the same type), Android takes the new
     * share for that same launch: it brings the old screen to the front and
     * drops the video without a word. CLEAR_TOP makes Android start a fresh
     * LauncherActivity on top of the task instead, as when the app was
     * opened from its icon.
     */
    private void forward(Intent forward) {
        forward.setClass(this, LauncherActivity.class);
        forward.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
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
