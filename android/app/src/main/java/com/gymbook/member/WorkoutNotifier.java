package com.gymbook.member;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Base64;
import android.view.View;
import android.widget.RemoteViews;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The ongoing "workout in progress" notification, Hevy-style: the exercise
 * up next, its set, a round picture of it, the session stopwatch (or the rest
 * countdown) in the header, and a Complete Set button.
 *
 * The web app decides what it says (liveNotificationContent in portal.js) and
 * hands it over through WorkoutNotificationPlugin; this class only draws it.
 * Static and context-based rather than part of the plugin, because a button
 * tapped after the app's activity is gone (WorkoutNotificationReceiver) and the
 * end of a rest both need it without a WebView.
 *
 * Payload (all optional but title):
 *   title, body
 *   chronometer  { base: epoch ms, countDown: bool } — the header's clock,
 *                drawn by the system, so it keeps ticking with the app asleep
 *                or killed
 *   image        base64 PNG, the large icon
 *   actions      [{ id, label }] — taps arrive back in the app as "action"
 *   rest         { endsAt: epoch ms, total: seconds } — Hevy's rest view
 *                (layout/notification_rest*.xml): body as "Next: …", then
 *                "Rest 1:03" and a draining bar. When it runs out, afterRest
 *                replaces this payload and, with the app in the background,
 *                restAlert pops up
 *   afterRest    a payload of its own
 *   restAlert    { title, body }
 */
final class WorkoutNotifier {

    static final String EXTRA_OPEN = "com.gymbook.member.OPEN_WORKOUT";
    static final String EXTRA_ACTION = "com.gymbook.member.WORKOUT_ACTION";

    private static final String CHANNEL_LIVE = "workout_live";
    private static final String CHANNEL_REST = "workout_rest";
    private static final int ID_LIVE = 7301;
    private static final int ID_REST = 7302;
    private static final int BRAND = 0xFFF97316;

    private static final String PREFS = "workout_notification";
    private static final String KEY_PAYLOAD = "payload";
    private static final String KEY_PENDING = "pending_actions";

    private static final Handler handler = new Handler(Looper.getMainLooper());
    private static Runnable restEnd;
    private static Runnable restTick;

    /** Whether the app is on screen — it beeps for a rest's end itself then. */
    static volatile boolean appVisible = false;

    // Decoding the same picture on every set would be wasted work.
    private static String lastImage;
    private static Bitmap lastBitmap;

    private WorkoutNotifier() {}

    static void show(Context context, JSONObject payload) {
        Context app = context.getApplicationContext();
        prefs(app).edit().putString(KEY_PAYLOAD, payload.toString()).apply();
        post(app, build(app, payload, false));
        scheduleRestEnd(app, payload);
    }

    static void clear(Context context) {
        Context app = context.getApplicationContext();
        cancelRestEnd();
        prefs(app).edit().remove(KEY_PAYLOAD).apply();
        NotificationManagerCompat manager = NotificationManagerCompat.from(app);
        manager.cancel(ID_LIVE);
        manager.cancel(ID_REST);
    }

    /** Back in the app: a "Rest over" still showing has done its job. */
    static void dismissRestAlert(Context context) {
        NotificationManagerCompat.from(context).cancel(ID_REST);
    }

    /**
     * A button tapped with no app to hand it to (its activity closed, or the
     * process killed and restarted just for the tap). The tap is kept for the
     * app's next start, and the notification says to open it, since nothing
     * else can update it in the meantime.
     */
    static void queueAction(Context context, String id) {
        Context app = context.getApplicationContext();
        SharedPreferences prefs = prefs(app);
        JSONArray pending;
        try {
            pending = new JSONArray(prefs.getString(KEY_PENDING, "[]"));
        } catch (JSONException e) {
            pending = new JSONArray();
        }
        try {
            pending.put(new JSONObject().put("id", id).put("at", System.currentTimeMillis()));
        } catch (JSONException ignored) {
            return;
        }
        prefs.edit().putString(KEY_PENDING, pending.toString()).apply();

        JSONObject payload = storedPayload(app);
        if (payload == null) return;
        cancelRestEnd();
        post(app, build(app, payload, true));
    }

    /** The taps queueAction kept, oldest first, forgotten once read. */
    static JSONArray takePendingActions(Context context) {
        SharedPreferences prefs = prefs(context.getApplicationContext());
        String raw = prefs.getString(KEY_PENDING, "[]");
        prefs.edit().remove(KEY_PENDING).apply();
        try {
            return new JSONArray(raw);
        } catch (JSONException e) {
            return new JSONArray();
        }
    }

    private static Notification build(Context context, JSONObject payload, boolean askToOpen) {
        ensureChannels(context);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_LIVE)
            .setSmallIcon(R.drawable.ic_stat_notify)
            .setColor(BRAND)
            .setContentTitle(payload.optString("title", "Workout in progress"))
            .setContentIntent(openIntent(context))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_WORKOUT)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setPriority(NotificationCompat.PRIORITY_LOW);

        String body = askToOpen ? "Open the app to log your set" : payload.optString("body", "");
        if (!body.isEmpty()) builder.setContentText(body);

        JSONObject chronometer = payload.optJSONObject("chronometer");
        if (chronometer != null && !askToOpen) {
            builder
                .setWhen(chronometer.optLong("base", System.currentTimeMillis()))
                .setShowWhen(true)
                .setUsesChronometer(true)
                .setChronometerCountDown(chronometer.optBoolean("countDown", false));
        } else {
            builder.setShowWhen(false);
        }

        Bitmap image = decodeImage(payload.optString("image", ""));
        JSONObject rest = askToOpen ? null : payload.optJSONObject("rest");
        long restLeft = rest == null ? 0 : rest.optLong("endsAt", 0) - System.currentTimeMillis();
        if (restLeft > 0) {
            // The picture sits inside the rest layout, beside the text.
            builder
                .setStyle(new NotificationCompat.DecoratedCustomViewStyle())
                .setCustomContentView(restViews(context, R.layout.notification_rest, payload, rest, restLeft, image))
                .setCustomBigContentView(restViews(context, R.layout.notification_rest_big, payload, rest, restLeft, image));
        } else if (image != null) {
            builder.setLargeIcon(image);
        }

        JSONArray actions = payload.optJSONArray("actions");
        if (actions != null && !askToOpen) {
            for (int i = 0; i < actions.length() && i < 3; i++) {
                JSONObject action = actions.optJSONObject(i);
                if (action == null) continue;
                String id = action.optString("id");
                builder.addAction(0, action.optString("label", id), actionIntent(context, id));
            }
        }
        return builder.build();
    }

    /** Hevy's rest view: the exercise, "Next: Set 2 of 3 (37 kg x 10 reps)"
     * (the expanded layout only), its picture, and "Rest 1:03" with its bar. */
    private static RemoteViews restViews(Context context, int layout, JSONObject payload, JSONObject rest, long leftMs, Bitmap image) {
        RemoteViews views = new RemoteViews(context.getPackageName(), layout);
        views.setTextViewText(R.id.rest_title, payload.optString("title", ""));
        if (layout == R.layout.notification_rest_big) views.setTextViewText(R.id.rest_next, payload.optString("body", ""));
        // A Chronometer counts against elapsedRealtime, not the wall clock.
        views.setChronometer(R.id.rest_time, SystemClock.elapsedRealtime() + leftMs, "Rest %s", true);
        views.setChronometerCountDown(R.id.rest_time, true);
        long totalMs = Math.max(1, rest.optLong("total", 0)) * 1000;
        views.setProgressBar(R.id.rest_progress, 1000, (int) Math.min(1000, leftMs * 1000 / Math.max(totalMs, leftMs)), false);
        if (image != null) {
            views.setImageViewBitmap(R.id.rest_image, image);
            views.setViewVisibility(R.id.rest_image, View.VISIBLE);
        } else {
            views.setViewVisibility(R.id.rest_image, View.GONE);
        }
        return views;
    }

    private static void scheduleRestEnd(Context app, JSONObject payload) {
        cancelRestEnd();
        JSONObject rest = payload.optJSONObject("rest");
        long endsAt = rest == null ? 0 : rest.optLong("endsAt", 0);
        JSONObject after = payload.optJSONObject("afterRest");
        if (endsAt <= 0 || after == null) return;
        // The countdown runs itself; the bar has to be moved on. Only while the
        // app's process lives — if it is killed, the bar stops but the time
        // still counts down.
        restTick = new Runnable() {
            @Override
            public void run() {
                long now = System.currentTimeMillis();
                if (now >= endsAt) return;
                post(app, build(app, payload, false));
                handler.postDelayed(this, Math.min(1000, endsAt - now));
            }
        };
        handler.postDelayed(restTick, 1000);
        JSONObject alert = payload.optJSONObject("restAlert");
        if (!after.has("image") && payload.has("image")) {
            try {
                after.put("image", payload.optString("image"));
            } catch (JSONException ignored) {}
        }
        restEnd = () -> {
            restEnd = null;
            show(app, after);
            if (!appVisible && alert != null) postRestAlert(app, alert);
        };
        handler.postDelayed(restEnd, Math.max(0, endsAt - System.currentTimeMillis()));
    }

    private static void cancelRestEnd() {
        if (restEnd != null) handler.removeCallbacks(restEnd);
        if (restTick != null) handler.removeCallbacks(restTick);
        restEnd = null;
        restTick = null;
    }

    private static void postRestAlert(Context context, JSONObject alert) {
        ensureChannels(context);
        Notification notification = new NotificationCompat.Builder(context, CHANNEL_REST)
            .setSmallIcon(R.drawable.ic_stat_notify)
            .setColor(BRAND)
            .setContentTitle(alert.optString("title", "Rest over"))
            .setContentText(alert.optString("body", ""))
            .setContentIntent(openIntent(context))
            .setAutoCancel(true)
            .setTimeoutAfter(60_000)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
            .build();
        try {
            NotificationManagerCompat.from(context).notify(ID_REST, notification);
        } catch (SecurityException ignored) {
            // Notifications not allowed: nothing to show.
        }
    }

    private static void post(Context context, Notification notification) {
        try {
            NotificationManagerCompat.from(context).notify(ID_LIVE, notification);
        } catch (SecurityException ignored) {
            // Android 13+ without POST_NOTIFICATIONS: the app asks on the
            // first workout (liveWorkout.js); until then there is nothing to do.
        }
    }

    private static void ensureChannels(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;
        NotificationChannel live = new NotificationChannel(CHANNEL_LIVE, "Workout in progress", NotificationManager.IMPORTANCE_LOW);
        live.setDescription("The running workout, with its next set and timer");
        live.setShowBadge(false);
        manager.createNotificationChannel(live);
        NotificationChannel rest = new NotificationChannel(CHANNEL_REST, "Rest timer", NotificationManager.IMPORTANCE_HIGH);
        rest.setDescription("When a rest between sets is over");
        rest.enableVibration(true);
        manager.createNotificationChannel(rest);
    }

    private static PendingIntent openIntent(Context context) {
        Intent intent = new Intent(context, MainActivity.class)
            .putExtra(EXTRA_OPEN, true)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(context, ID_LIVE, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static PendingIntent actionIntent(Context context, String id) {
        // A distinct action string per button, or Android would treat every
        // button's PendingIntent as the same one.
        Intent intent = new Intent(context, WorkoutNotificationReceiver.class)
            .setAction(EXTRA_ACTION + "." + id)
            .putExtra(EXTRA_ACTION, id);
        return PendingIntent.getBroadcast(context, id.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static Bitmap decodeImage(String base64) {
        if (base64 == null || base64.isEmpty()) return null;
        if (base64.equals(lastImage)) return lastBitmap;
        try {
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            lastBitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
            lastImage = base64;
            return lastBitmap;
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private static JSONObject storedPayload(Context context) {
        String raw = prefs(context).getString(KEY_PAYLOAD, null);
        if (raw == null) return null;
        try {
            return new JSONObject(raw);
        } catch (JSONException e) {
            return null;
        }
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
