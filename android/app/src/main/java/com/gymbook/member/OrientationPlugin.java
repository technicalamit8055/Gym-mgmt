package com.gymbook.member;

import android.content.pm.ActivityInfo;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Turns the screen for public/js/orientation.js. The WebView has no
 * screen.orientation.lock(), so a full-screen class would otherwise stay
 * upright: "landscape" follows the sensor between the two landscape sides,
 * "unlock" gives the phone back its own rotation.
 */
@CapacitorPlugin(name = "Orientation")
public class OrientationPlugin extends Plugin {

    @PluginMethod
    public void landscape(PluginCall call) {
        set(call, ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
    }

    @PluginMethod
    public void unlock(PluginCall call) {
        set(call, ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
    }

    private void set(PluginCall call, int orientation) {
        getActivity().runOnUiThread(() -> {
            getActivity().setRequestedOrientation(orientation);
            call.resolve();
        });
    }
}
