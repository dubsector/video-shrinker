package io.github.dubsector.videoshrinker;

import android.util.Log;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Locale;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLServerSocket;

/**
 * Serves the web app from the phone itself, as https://dubsector.github.io
 * would, so a test can release a new version of it whenever it likes. Chrome
 * is pointed here by the flags in chrome-command-line-local (pushed by
 * run-firebase-test.sh): a host rule sends dubsector.github.io to this
 * server, and the server's certificate is trusted by its key's hash.
 *
 * "Releasing a new version" serves the service worker with different bytes,
 * which is what Chrome compares when it checks for an update.
 */
class LocalSite {

    static final int PORT = 8443;
    private static final String BASE = "/video-shrinker/";

    private final File root;
    private final SSLServerSocket server;
    private volatile int version = 1;

    /** Unpacks the built site from `zip` and starts serving it. */
    LocalSite(File dir, InputStream zip, InputStream keyStore, char[] password) throws Exception {
        root = new File(dir, "site").getCanonicalFile();
        deleteTree(root);
        unzip(zip, root);
        if (!new File(root, "index.html").isFile()) throw new IOException("the site zip has no index.html");

        KeyStore keys = KeyStore.getInstance("PKCS12");
        keys.load(keyStore, password);
        KeyManagerFactory kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
        kmf.init(keys, password);
        SSLContext tls = SSLContext.getInstance("TLS");
        tls.init(kmf.getKeyManagers(), null, null);
        server = (SSLServerSocket) tls.getServerSocketFactory()
                .createServerSocket(PORT, 50, InetAddress.getByName("127.0.0.1"));

        Thread accept = new Thread(() -> {
            while (!server.isClosed()) {
                try {
                    Socket socket = server.accept();
                    new Thread(() -> handle(socket)).start();
                } catch (IOException e) {
                    // Closed by stop(), or a handshake that failed.
                }
            }
        }, "LocalSite");
        accept.setDaemon(true);
        accept.start();
    }

    /** Serves a new version of the app from now on. */
    void release(int newVersion) {
        version = newVersion;
        Log.i(WebApp.TAG, "local site: released version " + newVersion);
    }

    void stop() {
        try {
            server.close();
        } catch (IOException ignored) {
            // Already closed.
        }
    }

    private void handle(Socket socket) {
        try (Socket s = socket) {
            BufferedReader in = new BufferedReader(new InputStreamReader(s.getInputStream(), StandardCharsets.ISO_8859_1));
            String request = in.readLine();
            if (request == null) return;
            // Skip the headers; nothing here depends on them.
            for (String line; (line = in.readLine()) != null && !line.isEmpty(); ) { }
            String[] parts = request.split(" ");
            String path = parts.length > 1 ? parts[1].replaceFirst("[?#].*", "") : "/";
            OutputStream out = s.getOutputStream();
            if (!"GET".equals(parts[0]) || !path.startsWith(BASE)) {
                Log.i(WebApp.TAG, "local site: " + parts[0] + " " + path + " -> 404");
                respond(out, 404, "text/plain", new byte[0]);
                return;
            }
            String rel = path.substring(BASE.length());
            if (rel.isEmpty() || rel.endsWith("/")) rel += "index.html";
            File file = new File(root, rel).getCanonicalFile();
            if (!file.getPath().startsWith(root.getPath() + File.separator) || !file.isFile()) {
                respond(out, 404, "text/plain", new byte[0]);
                return;
            }
            byte[] body = readAll(file);
            if (rel.equals("sw.js") || rel.equals("index.html")) {
                Log.i(WebApp.TAG, "local site: served " + rel + " (version " + version + ")");
            }
            if (rel.equals("sw.js") && version > 1) {
                byte[] marker = ("\n// version " + version + "\n").getBytes(StandardCharsets.UTF_8);
                byte[] both = new byte[body.length + marker.length];
                System.arraycopy(body, 0, both, 0, body.length);
                System.arraycopy(marker, 0, both, body.length, marker.length);
                body = both;
            }
            respond(out, 200, typeOf(rel), body);
        } catch (IOException e) {
            // Chrome dropped the connection; nothing to do.
        }
    }

    private static void respond(OutputStream out, int status, String type, byte[] body) throws IOException {
        String head = "HTTP/1.1 " + status + (status == 200 ? " OK" : " Not Found") + "\r\n"
                + "Content-Type: " + type + "\r\n"
                + "Content-Length: " + body.length + "\r\n"
                + "Cache-Control: no-cache\r\n"
                + "Connection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.ISO_8859_1));
        out.write(body);
        out.flush();
    }

    private static String typeOf(String path) {
        String p = path.toLowerCase(Locale.ROOT);
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "text/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".webmanifest")) return "application/manifest+json";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".wasm")) return "application/wasm";
        return "application/octet-stream";
    }

    private static byte[] readAll(File file) throws IOException {
        try (InputStream in = new FileInputStream(file)) {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream((int) file.length());
            WebApp.copy(in, out);
            return out.toByteArray();
        }
    }

    private static void unzip(InputStream zip, File root) throws IOException {
        try (ZipInputStream in = new ZipInputStream(zip)) {
            for (ZipEntry entry; (entry = in.getNextEntry()) != null; ) {
                File out = new File(root, entry.getName()).getCanonicalFile();
                if (!out.getPath().startsWith(root.getPath() + File.separator)) continue;
                if (entry.isDirectory()) {
                    out.mkdirs();
                    continue;
                }
                out.getParentFile().mkdirs();
                try (OutputStream o = new FileOutputStream(out)) {
                    WebApp.copy(in, o);
                }
            }
        }
    }

    private static void deleteTree(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        file.delete();
    }
}
