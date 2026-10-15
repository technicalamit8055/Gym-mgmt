package com.gymbook.member;

import android.Manifest;
import android.content.Intent;
import android.os.Build;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.lang.ref.WeakReference;
import org.json.JSONArray;
import org.json.JSONException;

/**
 * The bridge to the workout notification (WorkoutNotifier) for public/js/liveWorkout.js.
 *
 * Events: "action" { id } for a tapped button, "open" when the notification
 * itself was tapped. Both are retained until the page listens, so a tap that
 * launched the app is not lost while it loads.
 */
@CapacitorPlugin(
    name = "WorkoutNotification",
    permissions = @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = WorkoutNotificationPlugin.DISPLAY)
)
public class WorkoutNotificationPlugin extends Plugin {

    static final String DISPLAY = "display";

    private static WeakReference<WorkoutNotificationPlugin> live = new WeakReference<>(null);

    /** Hands a button tap to the open app; false when there is none. */
    static boolean deliverAction(String id) {
        WorkoutNotificationPlugin plugin = live.get();
        if (plugin == null) return false;
        JSObject data = new JSObject();
        data.put("id", id);
        plugin.notifyListeners("action", data, true);
        return true;
    }

    @Override
    public void load() {
        live = new WeakReference<>(this);
        WorkoutNotifier.appVisible = true;
        handleOpenIntent(getActivity().getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        handleOpenIntent(intent);
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        WorkoutNotifier.appVisible = true;
        WorkoutNotifier.dismissRestAlert(getContext());
    }

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        WorkoutNotifier.appVisible = false;
    }

    @Override
    protected void handleOnDestroy() {
        super.handleOnDestroy();
        WorkoutNotifier.appVisible = false;
        if (live.get() == this) live = new WeakReference<>(null);
    }

    private void handleOpenIntent(Intent intent) {
        if (intent == null || !intent.getBooleanExtra(WorkoutNotifier.EXTRA_OPEN, false)) return;
        // Once only: the activity keeps its intent across recreation.
        intent.removeExtra(WorkoutNotifier.EXTRA_OPEN);
        notifyListeners("open", new JSObject(), true);
    }

    @PluginMethod
    public void show(PluginCall call) {
        WorkoutNotifier.show(getContext(), call.getData());
        call.resolve();
    }

    @PluginMethod
    public void clear(PluginCall call) {
        WorkoutNotifier.clear(getContext());
        call.resolve();
    }

    @PluginMethod
    public void takePendingActions(PluginCall call) {
        JSONArray pending = WorkoutNotifier.takePendingActions(getContext());
        JSObject result = new JSObject();
        try {
            result.put("actions", new JSArray(pending.toString()));
        } catch (JSONException e) {
            result.put("actions", new JSArray());
        }
        call.resolve(result);
    }

    // Below Android 13 posting needs no permission at all.

    @Override
    @PluginMethod
    public void checkPermissions(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            JSObject result = new JSObject();
            result.put(DISPLAY, "granted");
            call.resolve(result);
        } else {
            super.checkPermissions(call);
        }
    }

    @Override
    @PluginMethod
    public void requestPermissions(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || getPermissionState(DISPLAY) == PermissionState.GRANTED) {
            JSObject result = new JSObject();
            result.put(DISPLAY, "granted");
            call.resolve(result);
        } else {
            requestPermissionForAlias(DISPLAY, call, "permissionCallback");
        }
    }

    @PermissionCallback
    private void permissionCallback(PluginCall call) {
        checkPermissions(call);
    }
}
