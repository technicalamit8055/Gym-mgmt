package com.gymbook.member;

import android.content.Intent;
import android.os.Handler;
import android.os.Looper;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.lang.ref.WeakReference;

/**
 * The bridge to the home-screen widgets (GymWidgets) for public/js/widgets.js.
 *
 * Events: "open" { target } when a widget opened the app at a screen (retained
 * until the page listens, so the tap that launched the app is not lost), and
 * "changed" when a widget logged something itself — the water button — so an
 * open Diet tab can catch up.
 */
@CapacitorPlugin(name = "Widgets")
public class WidgetsPlugin extends Plugin {

    private static WeakReference<WidgetsPlugin> live = new WeakReference<>(null);

    static void deliverChanged() {
        new Handler(Looper.getMainLooper()).post(() -> {
            WidgetsPlugin plugin = live.get();
            if (plugin != null) plugin.notifyListeners("changed", new JSObject());
        });
    }

    @Override
    public void load() {
        live = new WeakReference<>(this);
        handleOpenIntent(getActivity().getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        handleOpenIntent(intent);
    }

    @Override
    protected void handleOnDestroy() {
        super.handleOnDestroy();
        if (live.get() == this) live = new WeakReference<>(null);
    }

    private void handleOpenIntent(Intent intent) {
        String target = intent == null ? null : intent.getStringExtra(GymWidgets.EXTRA_OPEN);
        if (target == null) return;
        // Once only: the activity keeps its intent across recreation.
        intent.removeExtra(GymWidgets.EXTRA_OPEN);
        JSObject data = new JSObject();
        data.put("target", target);
        notifyListeners("open", data, true);
    }

    @PluginMethod
    public void update(PluginCall call) {
        GymWidgets.save(getContext(), call.getData());
        call.resolve();
    }

    @PluginMethod
    public void clear(PluginCall call) {
        GymWidgets.clear(getContext());
        call.resolve();
    }
}
