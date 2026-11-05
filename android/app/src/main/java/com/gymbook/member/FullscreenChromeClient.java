package com.gymbook.member;

import android.app.Activity;
import android.graphics.Color;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebChromeClient;

/**
 * Real full screen for the page (public/js/classPlayer.js, the live class's
 * stage). Capacitor's own client hands every full-screen request straight
 * back, so a class "in full screen" stayed its small in-page size, its
 * controls and seek bar with it. This one lays the view the WebView renders
 * the full-screen element into over the whole window, and hides the status
 * and navigation bars until the page leaves full screen (or back is pressed,
 * MainActivity).
 */
class FullscreenChromeClient extends BridgeWebChromeClient {

    private final Activity activity;
    private View fullscreenView;
    private CustomViewCallback fullscreenCallback;

    FullscreenChromeClient(Bridge bridge) {
        super(bridge);
        activity = bridge.getActivity();
    }

    @Override
    public void onShowCustomView(View view, CustomViewCallback callback) {
        if (fullscreenView != null) {
            callback.onCustomViewHidden();
            return;
        }
        fullscreenView = view;
        fullscreenCallback = callback;
        view.setBackgroundColor(Color.BLACK);
        decor().addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(activity.getWindow(), decor());
        // A swipe from the edge shows them for a moment, as video apps do.
        bars.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        bars.hide(WindowInsetsCompat.Type.systemBars());
    }

    @Override
    public void onHideCustomView() {
        if (fullscreenView == null) return;
        decor().removeView(fullscreenView);
        fullscreenView = null;
        WindowCompat.getInsetsController(activity.getWindow(), decor()).show(WindowInsetsCompat.Type.systemBars());
        CustomViewCallback callback = fullscreenCallback;
        fullscreenCallback = null;
        // Tells the page it has left full screen (its fullscreenchange).
        callback.onCustomViewHidden();
    }

    /** Leaves full screen if the page is in it; false if it was not. */
    boolean exitFullscreen() {
        if (fullscreenView == null) return false;
        onHideCustomView();
        return true;
    }

    private ViewGroup decor() {
        return (ViewGroup) activity.getWindow().getDecorView();
    }
}
