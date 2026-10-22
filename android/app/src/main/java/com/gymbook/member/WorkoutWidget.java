package com.gymbook.member;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.graphics.Bitmap;
import android.os.SystemClock;
import android.view.View;
import android.widget.RemoteViews;
import java.util.Calendar;
import java.util.HashSet;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The workout widget, Hevy's: this week's workouts as a Monday-to-Sunday
 * strip, the weekly streak, and the plan's next day with a Start button that
 * opens the app already logging it (layout/widget_workout.xml).
 *
 * While a workout runs it shows that instead, from the workout notification's
 * own payload (WorkoutNotifier): the exercise up next, its set, the session
 * clock or the rest countdown, and the same buttons, which work the same way.
 * WorkoutNotifier redraws it on every change.
 */
public class WorkoutWidget extends AppWidgetProvider {

    private static final int[] DAY_IDS = {
        R.id.workout_day_0, R.id.workout_day_1, R.id.workout_day_2, R.id.workout_day_3,
        R.id.workout_day_4, R.id.workout_day_5, R.id.workout_day_6,
    };
    private static final String[] DAY_LETTERS = { "M", "T", "W", "T", "F", "S", "S" };
    private static final int[] ACTION_IDS = { R.id.workout_action_0, R.id.workout_action_1, R.id.workout_action_2 };

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        manager.updateAppWidget(ids, views(context));
    }

    static void refresh(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        int[] ids = manager.getAppWidgetIds(new ComponentName(context, WorkoutWidget.class));
        if (ids.length > 0) manager.updateAppWidget(ids, views(context));
    }

    private static RemoteViews views(Context context) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_workout);
        JSONObject live = WorkoutNotifier.storedPayload(context);
        if (live != null) {
            showLive(context, views, live);
            return views;
        }
        views.setViewVisibility(R.id.workout_live, View.GONE);
        views.setOnClickPendingIntent(R.id.widget_root, GymWidgets.openIntent(context, GymWidgets.OPEN_WORKOUT));

        JSONObject snapshot = GymWidgets.snapshot(context);
        String message = GymWidgets.message(snapshot);
        views.setViewVisibility(R.id.workout_message, message == null ? View.GONE : View.VISIBLE);
        views.setViewVisibility(R.id.workout_week, message == null ? View.VISIBLE : View.GONE);
        if (message != null) {
            views.setTextViewText(R.id.workout_message, message);
            return views;
        }

        JSONObject workout = snapshot.optJSONObject("workout");
        Set<String> dates = new HashSet<>();
        JSONArray logged = workout == null ? null : workout.optJSONArray("dates");
        for (int i = 0; logged != null && i < logged.length(); i++) dates.add(logged.optString(i));

        String today = GymWidgets.today();
        Calendar day = startOfWeek();
        int count = 0;
        for (int i = 0; i < DAY_IDS.length; i++) {
            String iso = GymWidgets.iso(day);
            boolean done = dates.contains(iso);
            if (done) count++;
            views.setTextViewText(DAY_IDS[i], DAY_LETTERS[i]);
            views.setInt(
                DAY_IDS[i],
                "setBackgroundResource",
                done ? R.drawable.widget_day_done : iso.equals(today) ? R.drawable.widget_day_today : R.drawable.widget_day_empty
            );
            int color = done ? 0xFFFFFFFF : context.getColor(iso.compareTo(today) > 0 ? R.color.widget_muted : R.color.widget_text);
            views.setTextColor(DAY_IDS[i], color);
            day.add(Calendar.DAY_OF_MONTH, 1);
        }
        views.setTextViewText(R.id.workout_count, count == 1 ? "1 workout this week" : count + " workouts this week");
        int streak = weekStreak(dates);
        views.setTextViewText(R.id.workout_streak, streak > 0 ? "🔥 " + streak + " wk streak" : "");

        JSONObject next = workout == null ? null : workout.optJSONObject("next");
        if (next != null) {
            int exercises = next.optInt("exercises");
            String plan = next.optString("plan", "");
            String detail = exercises + (exercises == 1 ? " exercise" : " exercises");
            views.setTextViewText(R.id.workout_next_label, "Next up · " + (plan.isEmpty() ? detail : plan + " · " + detail));
            views.setTextViewText(R.id.workout_next_name, next.optString("name", "Workout"));
            views.setTextViewText(R.id.workout_start, "▶  Start");
            views.setOnClickPendingIntent(R.id.workout_start, GymWidgets.openIntent(context, GymWidgets.OPEN_START));
        } else {
            views.setTextViewText(R.id.workout_next_label, "No workout planned today");
            views.setTextViewText(R.id.workout_next_name, "Log a workout");
            views.setTextViewText(R.id.workout_start, "Open");
            views.setOnClickPendingIntent(R.id.workout_start, GymWidgets.openIntent(context, GymWidgets.OPEN_WORKOUT));
        }
        return views;
    }

    private static void showLive(Context context, RemoteViews views, JSONObject payload) {
        views.setViewVisibility(R.id.workout_message, View.GONE);
        views.setViewVisibility(R.id.workout_week, View.GONE);
        views.setViewVisibility(R.id.workout_live, View.VISIBLE);
        views.setOnClickPendingIntent(R.id.widget_root, WorkoutNotifier.openIntent(context));

        // A button tapped with the app closed waits for it to open, as on the notification.
        boolean waiting = WorkoutNotifier.hasPendingActions(context);
        views.setTextViewText(R.id.workout_live_title, payload.optString("title", "Workout"));
        views.setTextViewText(R.id.workout_live_body, waiting ? "Open the app to log your set" : payload.optString("body", ""));

        JSONObject chronometer = payload.optJSONObject("chronometer");
        JSONObject rest = payload.optJSONObject("rest");
        long restLeft = rest == null ? 0 : rest.optLong("endsAt", 0) - System.currentTimeMillis();
        views.setTextViewText(R.id.workout_live_state, chronometer == null ? "Workout paused" : "Workout in progress");
        // A Chronometer counts against elapsedRealtime, not the wall clock.
        if (!waiting && restLeft > 0) {
            views.setChronometer(R.id.workout_clock, SystemClock.elapsedRealtime() + restLeft, "Rest %s", true);
            views.setChronometerCountDown(R.id.workout_clock, true);
            views.setViewVisibility(R.id.workout_clock, View.VISIBLE);
        } else if (chronometer != null) {
            long since = System.currentTimeMillis() - chronometer.optLong("base", System.currentTimeMillis());
            views.setChronometer(R.id.workout_clock, SystemClock.elapsedRealtime() - since, null, true);
            views.setChronometerCountDown(R.id.workout_clock, false);
            views.setViewVisibility(R.id.workout_clock, View.VISIBLE);
        } else {
            views.setChronometer(R.id.workout_clock, SystemClock.elapsedRealtime(), null, false);
            views.setViewVisibility(R.id.workout_clock, View.GONE);
        }

        Bitmap image = WorkoutNotifier.decodeImage(payload.optString("image", ""));
        if (image != null) views.setImageViewBitmap(R.id.workout_live_image, image);
        views.setViewVisibility(R.id.workout_live_image, image != null ? View.VISIBLE : View.GONE);

        JSONArray actions = waiting ? null : payload.optJSONArray("actions");
        for (int i = 0; i < ACTION_IDS.length; i++) {
            JSONObject action = actions == null ? null : actions.optJSONObject(i);
            if (action == null) {
                views.setViewVisibility(ACTION_IDS[i], View.GONE);
                continue;
            }
            String id = action.optString("id");
            views.setTextViewText(ACTION_IDS[i], action.optString("label", id));
            views.setOnClickPendingIntent(ACTION_IDS[i], WorkoutNotifier.actionIntent(context, id));
            views.setViewVisibility(ACTION_IDS[i], View.VISIBLE);
        }
    }

    /** This week's Monday, at midnight. */
    private static Calendar startOfWeek() {
        Calendar day = Calendar.getInstance();
        day.set(Calendar.HOUR_OF_DAY, 0);
        day.set(Calendar.MINUTE, 0);
        day.set(Calendar.SECOND, 0);
        day.set(Calendar.MILLISECOND, 0);
        // DAY_OF_WEEK runs Sunday = 1 … Saturday = 7.
        day.add(Calendar.DAY_OF_MONTH, -((day.get(Calendar.DAY_OF_WEEK) + 5) % 7));
        return day;
    }

    /**
     * Hevy's streak: weeks in a row with at least one workout. The week under
     * way only adds to it — it cannot break it until it is over.
     */
    private static int weekStreak(Set<String> dates) {
        Calendar week = startOfWeek();
        if (!anyInWeek(dates, week)) week.add(Calendar.DAY_OF_MONTH, -7);
        int streak = 0;
        while (anyInWeek(dates, week)) {
            streak++;
            week.add(Calendar.DAY_OF_MONTH, -7);
        }
        return streak;
    }

    private static boolean anyInWeek(Set<String> dates, Calendar monday) {
        Calendar day = (Calendar) monday.clone();
        for (int i = 0; i < 7; i++) {
            if (dates.contains(GymWidgets.iso(day))) return true;
            day.add(Calendar.DAY_OF_MONTH, 1);
        }
        return false;
    }
}
