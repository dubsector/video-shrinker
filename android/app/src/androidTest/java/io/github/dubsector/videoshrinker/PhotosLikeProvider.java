package io.github.dubsector.videoshrinker;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
import android.provider.OpenableColumns;
import android.util.Log;

import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;

/**
 * Serves a video the awkward ways Google Photos can: under a display name
 * with no extension, with no size, with no type, and as a slow, unseekable
 * stream, as when Photos downloads a cloud-only item while the receiver
 * reads it. It runs in the test package, so to the app it is another app.
 *
 * URIs look like content://AUTHORITY/NAME?type=TYPE&size=1&kbps=N&emptyFirst=1. Whatever
 * the name, it serves the one video the test puts in the app's files
 * (SOURCE, granted to this package); type and size are reported only when
 * given; kbps throttles the stream; emptyFirst makes the first read of a
 * name end at once with no data, as a sender's stream sometimes does.
 */
public class PhotosLikeProvider extends ContentProvider {

    static final String SOURCE_NAME = "photos-source.mp4";
    // Names already served empty once (see emptyFirst).
    private static final Set<String> EMPTIED = Collections.synchronizedSet(new HashSet<String>());
    // Fixed rather than taken from the URI: this provider is exported, so it
    // mustn't serve whatever another app asks it for.
    private static final Uri SOURCE =
            Uri.parse("content://io.github.dubsector.videoshrinker.fileprovider/twa_splash/" + SOURCE_NAME);

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        if (projection == null) projection = new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE};
        MatrixCursor cursor = new MatrixCursor(projection);
        Object[] row = new Object[projection.length];
        for (int i = 0; i < projection.length; i++) {
            if (OpenableColumns.DISPLAY_NAME.equals(projection[i])) {
                row[i] = uri.getLastPathSegment();
            } else if (OpenableColumns.SIZE.equals(projection[i]) && uri.getQueryParameter("size") != null) {
                row[i] = sizeOf(SOURCE);
            }
        }
        cursor.addRow(row);
        return cursor;
    }

    @Override
    public String getType(Uri uri) {
        return uri.getQueryParameter("type");
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        final Uri source = SOURCE;
        String kbps = uri.getQueryParameter("kbps");
        final long bytesPerSecond = kbps == null ? 0 : Long.parseLong(kbps) * 1024;
        final ParcelFileDescriptor[] pipe;
        try {
            pipe = ParcelFileDescriptor.createReliablePipe();
        } catch (IOException e) {
            throw new FileNotFoundException(e.toString());
        }
        if (uri.getQueryParameter("emptyFirst") != null && EMPTIED.add(uri.getLastPathSegment())) {
            // A stream that ends at once with no error, the first time only.
            try {
                pipe[1].close();
            } catch (IOException ignored) {
                // Nothing to close.
            }
            return pipe[0];
        }
        new Thread(new Runnable() {
            @Override
            public void run() {
                ParcelFileDescriptor write = pipe[1];
                try (InputStream in = getContext().getContentResolver().openInputStream(source);
                     OutputStream out = new ParcelFileDescriptor.AutoCloseOutputStream(write)) {
                    if (in == null) throw new IOException("could not open " + source);
                    long started = SystemClock.uptimeMillis();
                    long sent = 0;
                    byte[] buffer = new byte[32 * 1024];
                    for (int n; (n = in.read(buffer)) > 0; ) {
                        out.write(buffer, 0, n);
                        sent += n;
                        if (bytesPerSecond > 0) {
                            long due = started + sent * 1000 / bytesPerSecond;
                            long wait = due - SystemClock.uptimeMillis();
                            if (wait > 0) SystemClock.sleep(wait);
                        }
                    }
                } catch (IOException e) {
                    // The reader stopping early (say, a cancelled share) ends
                    // up here too.
                    Log.w(WebApp.TAG, "PhotosLikeProvider stopped serving " + source + ": " + e);
                    try {
                        write.closeWithError(e.toString());
                    } catch (IOException ignored) {
                        // Already closed.
                    }
                }
            }
        }).start();
        return pipe[0];
    }

    private Long sizeOf(Uri source) {
        try (ParcelFileDescriptor fd = getContext().getContentResolver().openFileDescriptor(source, "r")) {
            return fd == null ? null : fd.getStatSize();
        } catch (IOException e) {
            return null;
        }
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        throw new UnsupportedOperationException();
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException();
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException();
    }
}
