package com.gymbook.member;

import android.os.Bundle;
import android.widget.ScrollView;
import android.widget.TextView;
import androidx.appcompat.app.AppCompatActivity;

/**
 * What the app does with Health Connect data, in plain words. Health Connect
 * opens this from its permission screen and settings (see the manifest), and
 * will not show the permission screen to an app without it.
 */
public class HealthPermissionsRationaleActivity extends AppCompatActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (getSupportActionBar() != null) getSupportActionBar().setDisplayHomeAsUpEnabled(true);

        int pad = Math.round(20 * getResources().getDisplayMetrics().density);
        TextView text = new TextView(this);
        text.setText(R.string.health_rationale);
        text.setTextSize(16);
        text.setLineSpacing(0, 1.25f);
        text.setPadding(pad, pad, pad, pad);

        ScrollView scroll = new ScrollView(this);
        scroll.addView(text);
        setContentView(scroll);
    }

    @Override
    public boolean onSupportNavigateUp() {
        finish();
        return true;
    }
}
