package com.gymbook.member;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.widget.RemoteViews;
import android.widget.Toast;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The diet tracker widget: today's calorie ring with what is left of the
 * budget (goal plus the exercise eaten back, as on the Diet tab), protein /
 * carbs / fat against target, water with a +250 ml button, and + Food, which
 * opens the food search. Draws GymWidgets' snapshot (layout/widget_diet.xml).
 *
 * The water button is the one tap handled without the app: it posts to the
 * same endpoint as the Diet tab's glass, with the member's token from the
 * snapshot, and shows the new total at once.
 */
public class DietWidget extends AppWidgetProvider {

    static final String ACTION_ADD_WATER = "com.gymbook.member.WIDGET_ADD_WATER";
    private static final int WATER_STEP_ML = 250;
    private static final int OVER = 0xFFEF4444;

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        manager.updateAppWidget(ids, views(context));
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        super.onReceive(context, intent);
        if (ACTION_ADD_WATER.equals(intent.getAction())) addWater(context);
    }

    static void refresh(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        int[] ids = manager.getAppWidgetIds(new ComponentName(context, DietWidget.class));
        if (ids.length > 0) manager.updateAppWidget(ids, views(context));
    }

    private static RemoteViews views(Context context) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_diet);
        views.setOnClickPendingIntent(R.id.widget_root, GymWidgets.openIntent(context, GymWidgets.OPEN_DIET));

        JSONObject snapshot = GymWidgets.snapshot(context);
        String message = GymWidgets.message(snapshot);
        JSONObject diet = GymWidgets.dietToday(snapshot);
        if (message == null && diet == null) message = "Open the Diet tab in GymVym to start tracking";
        boolean ready = message == null;
        views.setViewVisibility(R.id.diet_message, ready ? View.GONE : View.VISIBLE);
        views.setViewVisibility(R.id.diet_content, ready ? View.VISIBLE : View.GONE);
        if (!ready) {
            views.setTextViewText(R.id.diet_message, message);
            return views;
        }

        int budget = diet.optInt("goal") + diet.optInt("exercise");
        int eaten = diet.optInt("eaten");
        int left = budget - eaten;
        views.setImageViewBitmap(R.id.diet_ring, ring(context, eaten, budget));
        views.setTextViewText(R.id.diet_left, GymWidgets.number(Math.abs(left)));
        views.setTextViewText(R.id.diet_left_label, left >= 0 ? "kcal left" : "kcal over");

        macro(views, R.id.diet_protein_value, R.id.diet_protein_bar, diet, "protein");
        macro(views, R.id.diet_carbs_value, R.id.diet_carbs_bar, diet, "carbs");
        macro(views, R.id.diet_fats_value, R.id.diet_fats_bar, diet, "fats");

        int water = diet.optInt("water_ml");
        int waterTarget = diet.optInt("water_target_ml");
        views.setTextViewText(R.id.diet_water, "Water  " + litres(water) + " / " + litres(waterTarget) + " L");
        views.setProgressBar(R.id.diet_water_bar, 1000, permille(water, waterTarget), false);

        views.setOnClickPendingIntent(R.id.diet_add_water, waterIntent(context));
        views.setOnClickPendingIntent(R.id.diet_log_food, GymWidgets.openIntent(context, GymWidgets.OPEN_FOOD));
        return views;
    }

    private static void macro(RemoteViews views, int valueId, int barId, JSONObject diet, String key) {
        double eaten = diet.optDouble(key, 0);
        double target = diet.optDouble(key + "_target", 0);
        views.setTextViewText(valueId, Math.round(eaten) + " / " + Math.round(target) + " g");
        views.setProgressBar(barId, 1000, permille(eaten, target), false);
    }

    private static int permille(double value, double target) {
        return target > 0 ? (int) Math.min(1000, Math.round(value * 1000 / target)) : 0;
    }

    /** 1250 → "1.25", 3000 → "3". */
    private static String litres(int ml) {
        String text = String.format(Locale.US, "%.2f", ml / 1000.0);
        return text.replaceAll("\\.?0+$", "");
    }

    /** The calorie ring: eaten against the day's budget, red once past it. */
    private static Bitmap ring(Context context, int eaten, int budget) {
        int size = Math.round(72 * context.getResources().getDisplayMetrics().density);
        float stroke = size * 0.11f;
        Bitmap bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(stroke);
        paint.setStrokeCap(Paint.Cap.ROUND);
        RectF box = new RectF(stroke / 2, stroke / 2, size - stroke / 2, size - stroke / 2);
        paint.setColor(context.getColor(R.color.widget_track));
        canvas.drawArc(box, 0, 360, false, paint);
        float share = budget > 0 ? Math.min(1f, eaten / (float) budget) : 0;
        if (share > 0) {
            paint.setColor(eaten > budget ? OVER : context.getColor(R.color.widget_brand));
            canvas.drawArc(box, -90, Math.max(1f, 360 * share), false, paint);
        }
        return bitmap;
    }

    private static PendingIntent waterIntent(Context context) {
        Intent intent = new Intent(context, DietWidget.class).setAction(ACTION_ADD_WATER);
        return PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private void addWater(Context context) {
        Context app = context.getApplicationContext();
        JSONObject snapshot = GymWidgets.snapshot(app);
        JSONObject water = snapshot == null ? null : snapshot.optJSONObject("water");
        if (water == null || GymWidgets.dietToday(snapshot) == null) return;
        String day = GymWidgets.today();
        GymWidgets.bumpWater(app, WATER_STEP_ML);
        PendingResult pending = goAsync();
        new Thread(() -> {
            try {
                sendWater(app, water, day);
            } finally {
                pending.finish();
            }
        }).start();
    }

    private static void sendWater(Context app, JSONObject water, String day) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(water.getString("url")).openConnection();
            connection.setConnectTimeout(8000);
            connection.setReadTimeout(8000);
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setRequestProperty("Authorization", "Bearer " + water.getString("token"));
            byte[] body = new JSONObject().put("add_ml", WATER_STEP_ML).put("log_date", day).toString().getBytes(StandardCharsets.UTF_8);
            try (OutputStream out = connection.getOutputStream()) {
                out.write(body);
            }
            int status = connection.getResponseCode();
            if (status == 401) {
                // Signed out (or the session ended from another device): the app
                // will say so too the next time it opens.
                GymWidgets.clear(app);
                return;
            }
            if (status / 100 != 2) {
                // Refused — the add-on lapsed, say. The app explains why.
                GymWidgets.bumpWater(app, -WATER_STEP_ML);
                toast(app, "Couldn't add water — open GymVym to log it");
                return;
            }
            JSONObject result = new JSONObject(read(connection.getInputStream()));
            GymWidgets.setWater(app, result.optString("log_date", day), result.optInt("water_ml", -1));
            WidgetsPlugin.deliverChanged();
        } catch (IOException | JSONException e) {
            GymWidgets.bumpWater(app, -WATER_STEP_ML);
            toast(app, "Couldn't add water — check your connection");
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static void toast(Context app, String text) {
        new Handler(Looper.getMainLooper()).post(() -> Toast.makeText(app, text, Toast.LENGTH_SHORT).show());
    }

    private static String read(InputStream in) throws IOException {
        try (InputStream stream = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[4096];
            for (int n; (n = stream.read(buffer)) != -1; ) out.write(buffer, 0, n);
            return out.toString("UTF-8");
        }
    }
}
