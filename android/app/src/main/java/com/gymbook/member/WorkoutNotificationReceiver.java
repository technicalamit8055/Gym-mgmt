package com.gymbook.member;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** A button on the workout notification: handed to the running app, or kept
 * for its next start when there is none (see WorkoutNotifier.queueAction). */
public class WorkoutNotificationReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        String id = intent.getStringExtra(WorkoutNotifier.EXTRA_ACTION);
        if (id == null) return;
        if (!WorkoutNotificationPlugin.deliverAction(id)) WorkoutNotifier.queueAction(context, id);
    }
}
