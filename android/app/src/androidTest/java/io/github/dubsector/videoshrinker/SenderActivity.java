package io.github.dubsector.videoshrinker;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;

/**
 * Sends the share intent it is given (extra "share") from its own task, the
 * way a gallery app's share sheet does: without FLAG_ACTIVITY_NEW_TASK, so
 * the receiver starts on top of the sender. The test itself can only start
 * activities in a new task.
 */
public class SenderActivity extends Activity {

    static final String EXTRA_SHARE = "share";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Intent share = getIntent().getParcelableExtra(EXTRA_SHARE);
        // Stays open underneath, as the gallery would.
        if (share != null) startActivity(share);
    }
}
