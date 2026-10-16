package com.gymbook.member;

import android.os.Bundle;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The app's own plugins, which Capacitor does not find by itself.
        registerPlugin(WorkoutNotificationPlugin.class);
        super.onCreate(savedInstanceState);

        // Without a handler, Android's back closes the app from any screen.
        // The page decides instead (window.gymvymBack in app.js): it closes the
        // top sheet, screen or tab the way its own back arrows do, and answers
        // false once there is nothing left — then the app leaves to the home
        // screen, still running, the way Android's back does on a root screen.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView webView = bridge == null ? null : bridge.getWebView();
                if (webView == null) {
                    moveTaskToBack(true);
                    return;
                }
                webView.evaluateJavascript(
                    "typeof window.gymvymBack === 'function' && window.gymvymBack() === true",
                    (handled) -> {
                        if (!"true".equals(handled)) moveTaskToBack(true);
                    }
                );
            }
        });
    }
}
