package com.gymbook.member

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.activity.result.ActivityResult
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.aggregate.AggregateMetric
import androidx.health.connect.client.aggregate.AggregationResult
import androidx.health.connect.client.records.ActiveCaloriesBurnedRecord
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.HydrationRecord
import androidx.health.connect.client.records.MealType
import androidx.health.connect.client.records.NutritionRecord
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.records.metadata.Device
import androidx.health.connect.client.records.metadata.Metadata
import androidx.health.connect.client.request.AggregateGroupByPeriodRequest
import androidx.health.connect.client.time.TimeRangeFilter
import androidx.health.connect.client.units.Energy
import androidx.health.connect.client.units.Length
import androidx.health.connect.client.units.Mass
import androidx.health.connect.client.units.Volume
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.Period
import java.time.ZoneId
import java.time.ZoneOffset
import kotlin.reflect.KClass
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * Health Connect for public/js/healthConnect.js: whether it is on the phone,
 * its permission screen, daily totals for the last few days, and writing the
 * member's workouts, meals, weigh-ins and water so Google Fit, Samsung Health
 * and the rest show them (the way Hevy's workouts and weigh-ins do).
 *
 * Reads are aggregates only: Health Connect de-duplicates what several apps
 * wrote about the same walk, so these are the numbers its own dashboard
 * shows. A day is this phone's calendar day.
 *
 * Health Connect needs Android 9+. The app's minSdk is lower (the library's
 * own 26 is overridden in the manifest), so every method checks first, and
 * nothing touches Health Connect or java.time on an older phone — the metric
 * table below holds only strings and lambdas for that reason.
 */
@CapacitorPlugin(name = "HealthConnect")
class HealthConnectPlugin : Plugin() {

    /** One thing the app reads: its name for JS, its field in a day, the
     * permission (also declared in the gymvym manifest), and how to total it. */
    private class Metric(
        val name: String,
        val field: String,
        val permission: String,
        val aggregate: () -> AggregateMetric<*>,
        val toNumber: (Any) -> Double,
    )

    companion object {
        private val METRICS = listOf(
            Metric("steps", "steps", "android.permission.health.READ_STEPS", { StepsRecord.COUNT_TOTAL }) {
                (it as Long).toDouble()
            },
            Metric(
                "active_calories", "active_calories", "android.permission.health.READ_ACTIVE_CALORIES_BURNED",
                { ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL },
            ) { (it as Energy).inKilocalories },
            Metric("distance", "distance_m", "android.permission.health.READ_DISTANCE", { DistanceRecord.DISTANCE_TOTAL }) {
                (it as Length).inMeters
            },
            Metric("exercise", "active_minutes", "android.permission.health.READ_EXERCISE", { ExerciseSessionRecord.EXERCISE_DURATION_TOTAL }) {
                (it as Duration).toMinutes().toDouble()
            },
        )
        /** What the app writes: workouts finished in the logger, meals,
         * weigh-ins and water. */
        private const val WRITE_WORKOUTS = "android.permission.health.WRITE_EXERCISE"
        private const val WRITE_MEALS = "android.permission.health.WRITE_NUTRITION"
        private const val WRITE_WEIGHT = "android.permission.health.WRITE_WEIGHT"
        private const val WRITE_WATER = "android.permission.health.WRITE_HYDRATION"
        private val WRITES = mapOf(
            "write_workouts" to WRITE_WORKOUTS,
            "write_meals" to WRITE_MEALS,
            "write_weight" to WRITE_WEIGHT,
            "write_water" to WRITE_WATER,
        )
        private val ALL_PERMISSIONS = METRICS.map { it.permission }.toSet() + WRITES.values
        private val MEAL_TYPES = mapOf(
            "breakfast" to MealType.MEAL_TYPE_BREAKFAST,
            "lunch" to MealType.MEAL_TYPE_LUNCH,
            "dinner" to MealType.MEAL_TYPE_DINNER,
            "snack" to MealType.MEAL_TYPE_SNACK,
            "pre_workout" to MealType.MEAL_TYPE_SNACK,
            "post_workout" to MealType.MEAL_TYPE_SNACK,
        )
        private const val MAX_DAYS = 30
        private const val PLAY_STORE_PAGE =
            "market://details?id=com.google.android.apps.healthdata&url=healthconnect%3A%2F%2Fonboarding"
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val client by lazy { HealthConnectClient.getOrCreate(context) }

    override fun handleOnDestroy() {
        scope.cancel()
        super.handleOnDestroy()
    }

    /** available | not_installed | update_required | unsupported. Before
     * Android 14 Health Connect is an app from the Play Store; from 14 it is
     * part of Android, so "unavailable" there means it never will be. */
    private fun sdkStatus(): String {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return "unsupported"
        return when (HealthConnectClient.getSdkStatus(context)) {
            HealthConnectClient.SDK_AVAILABLE -> "available"
            HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> "update_required"
            else -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) "unsupported" else "not_installed"
        }
    }

    /** `{ status, granted }`: the metric names it may read, plus
     * write_workouts, write_meals, write_weight and write_water for what it
     * may write. */
    @PluginMethod
    fun status(call: PluginCall) = resolveStatus(call)

    private fun resolveStatus(call: PluginCall) {
        val status = sdkStatus()
        if (status != "available") {
            call.resolve(JSObject().put("status", status).put("granted", JSArray()))
            return
        }
        scope.launch {
            try {
                val granted = client.permissionController.getGrantedPermissions()
                val names = JSArray()
                METRICS.filter { it.permission in granted }.forEach { names.put(it.name) }
                WRITES.filterValues { it in granted }.keys.forEach { names.put(it) }
                call.resolve(JSObject().put("status", status).put("granted", names))
            } catch (e: Exception) {
                call.reject(e.message ?: "Could not reach Health Connect", e)
            }
        }
    }

    /** Health Connect's own permission screen, reads and writes at once; the
     * member can untick any. Resolves like status() once it closes. (Not
     * "requestPermissions": Plugin already has one, for runtime permissions.) */
    @PluginMethod
    fun requestAccess(call: PluginCall) {
        if (sdkStatus() != "available") {
            call.reject("Health Connect is not available on this phone", "UNAVAILABLE")
            return
        }
        val intent = PermissionController.createRequestPermissionResultContract()
            .createIntent(context, ALL_PERMISSIONS)
        startActivityForResult(call, intent, "accessResult")
    }

    @ActivityCallback
    private fun accessResult(call: PluginCall?, @Suppress("UNUSED_PARAMETER") result: ActivityResult) {
        if (call != null) resolveStatus(call)
    }

    /**
     * `{ days: [{ date, steps, active_calories, distance_m, active_minutes }] }`
     * for the last `days` days (today included), oldest first. A metric the
     * member did not allow is null; one allowed with nothing recorded is 0.
     */
    @PluginMethod
    fun readDaily(call: PluginCall) {
        if (sdkStatus() != "available") {
            call.reject("Health Connect is not available on this phone", "UNAVAILABLE")
            return
        }
        val days = (call.getInt("days") ?: 7).coerceIn(1, MAX_DAYS)
        scope.launch {
            try {
                val granted = client.permissionController.getGrantedPermissions()
                val allowed = METRICS.filter { it.permission in granted }
                val first = LocalDate.now().minusDays((days - 1).toLong())
                val byDate = HashMap<LocalDate, AggregationResult>()
                if (allowed.isNotEmpty()) {
                    val groups = client.aggregateGroupByPeriod(
                        AggregateGroupByPeriodRequest(
                            metrics = allowed.map { it.aggregate() }.toSet(),
                            timeRangeFilter = TimeRangeFilter.between(
                                first.atStartOfDay(),
                                LocalDate.now().plusDays(1).atStartOfDay(),
                            ),
                            timeRangeSlicer = Period.ofDays(1),
                        ),
                    )
                    groups.forEach { byDate[it.startTime.toLocalDate()] = it.result }
                }

                val out = JSArray()
                for (i in 0 until days) {
                    val date = first.plusDays(i.toLong())
                    val day = JSObject().put("date", date.toString())
                    for (metric in METRICS) {
                        if (metric !in allowed) {
                            day.put(metric.field, JSONObject.NULL)
                            continue
                        }
                        @Suppress("UNCHECKED_CAST")
                        val raw = byDate[date]?.get(metric.aggregate() as AggregateMetric<Any>)
                        day.put(metric.field, if (raw == null) 0.0 else metric.toNumber(raw))
                    }
                    out.put(day)
                }
                call.resolve(JSObject().put("days", out))
            } catch (e: Exception) {
                call.reject(e.message ?: "Could not read Health Connect", e)
            }
        }
    }

    /** One kind of record the app writes: its key in writeRecords' payload,
     * the permission it needs, its record class, and how to build one. */
    private class WriteKind(
        val key: String,
        val permission: String,
        val type: KClass<out Record>,
        val build: (JSONObject, Long) -> Record,
    )

    private fun writeKinds() = listOf(
        WriteKind("workouts", WRITE_WORKOUTS, ExerciseSessionRecord::class, ::workoutRecord),
        WriteKind("meals", WRITE_MEALS, NutritionRecord::class, ::mealRecord),
        WriteKind("weights", WRITE_WEIGHT, WeightRecord::class, ::weightRecord),
        WriteKind("water", WRITE_WATER, HydrationRecord::class, ::waterRecord),
    )

    /**
     * Writes what the app logged (src/wearables.js's healthConnectExport),
     * and deletes what has since been removed from the app:
     *
     *   { version, workouts: [{ id, title, start, end }],
     *     meals: [{ id, name, meal_type, time, calories, protein_g, … }],
     *     weights: [{ id, time, weight_kg }],
     *     water: [{ id, start, end, volume_ml }],
     *     delete_workouts: [id], delete_meals, delete_weights, delete_water }
     *
     * `id` is the record's clientRecordId, so writing one again replaces it —
     * as long as `version` is higher than last time, which is why the page
     * sends the time. A kind the member did not allow is skipped, and
     * reported false in `{ workouts, meals, weights, water }` so the page
     * tries it again later.
     */
    @PluginMethod
    fun writeRecords(call: PluginCall) {
        if (sdkStatus() != "available") {
            call.reject("Health Connect is not available on this phone", "UNAVAILABLE")
            return
        }
        val version = call.getLong("version") ?: System.currentTimeMillis()
        val kinds = writeKinds()
        val writes = kinds.associateWith { call.getArray(it.key) ?: JSArray() }
        val deletes = kinds.associateWith { (call.getArray("delete_${it.key}") ?: JSArray()).toList<String>() }
        scope.launch {
            try {
                val granted = client.permissionController.getGrantedPermissions()
                val allowed = kinds.filter { it.permission in granted }
                val records = mutableListOf<Record>()
                for (kind in allowed) {
                    val items = writes.getValue(kind)
                    for (i in 0 until items.length()) records.add(kind.build(items.getJSONObject(i), version))
                }
                if (records.isNotEmpty()) client.insertRecords(records)
                for (kind in allowed) {
                    val ids = deletes.getValue(kind)
                    if (ids.isNotEmpty()) client.deleteRecords(kind.type, emptyList(), ids)
                }
                val done = JSObject()
                kinds.forEach { done.put(it.key, it in allowed) }
                call.resolve(done)
            } catch (e: Exception) {
                call.reject(e.message ?: "Could not write to Health Connect", e)
            }
        }
    }

    private fun offsetAt(instant: Instant): ZoneOffset = ZoneId.systemDefault().rules.getOffset(instant)

    private fun workoutRecord(json: JSONObject, version: Long): ExerciseSessionRecord {
        val start = Instant.parse(json.getString("start"))
        val end = Instant.parse(json.getString("end"))
        return ExerciseSessionRecord(
            startTime = start,
            startZoneOffset = offsetAt(start),
            endTime = end,
            endZoneOffset = offsetAt(end),
            metadata = Metadata.activelyRecorded(
                Device(type = Device.TYPE_PHONE),
                clientRecordId = json.getString("id"),
                clientRecordVersion = version,
            ),
            exerciseType = ExerciseSessionRecord.EXERCISE_TYPE_WEIGHTLIFTING,
            title = json.optString("title").ifBlank { null },
        )
    }

    /** A meal is an instant in the app; Health Connect wants an interval, so
     * it is given the minute before. */
    private fun mealRecord(json: JSONObject, version: Long): NutritionRecord {
        val end = Instant.parse(json.getString("time"))
        val start = end.minusSeconds(60)
        val grams = { key: String -> json.optDouble(key, 0.0).takeIf { it > 0 }?.let { Mass.grams(it) } }
        return NutritionRecord(
            startTime = start,
            startZoneOffset = offsetAt(start),
            endTime = end,
            endZoneOffset = offsetAt(end),
            metadata = Metadata.manualEntry(clientRecordId = json.getString("id"), clientRecordVersion = version),
            name = json.optString("name").ifBlank { null },
            mealType = MEAL_TYPES[json.optString("meal_type")] ?: MealType.MEAL_TYPE_UNKNOWN,
            energy = Energy.kilocalories(json.optDouble("calories", 0.0)),
            protein = grams("protein_g"),
            totalCarbohydrate = grams("carbs_g"),
            totalFat = grams("fats_g"),
            dietaryFiber = grams("fiber_g"),
            sugar = grams("sugar_g"),
        )
    }

    private fun weightRecord(json: JSONObject, version: Long): WeightRecord {
        val time = Instant.parse(json.getString("time"))
        return WeightRecord(
            time = time,
            zoneOffset = offsetAt(time),
            weight = Mass.kilograms(json.getDouble("weight_kg")),
            metadata = Metadata.manualEntry(clientRecordId = json.getString("id"), clientRecordVersion = version),
        )
    }

    /** A day's water, the only way the app keeps it: midnight to the last glass. */
    private fun waterRecord(json: JSONObject, version: Long): HydrationRecord {
        val start = Instant.parse(json.getString("start"))
        val end = Instant.parse(json.getString("end"))
        return HydrationRecord(
            startTime = start,
            startZoneOffset = offsetAt(start),
            endTime = end,
            endZoneOffset = offsetAt(end),
            volume = Volume.milliliters(json.getDouble("volume_ml")),
            metadata = Metadata.manualEntry(clientRecordId = json.getString("id"), clientRecordVersion = version),
        )
    }

    /** Where the member can change what GymVym reads — this app's page in
     * Health Connect on Android 14+, its settings before that — or its Play
     * Store page when it is missing or out of date. */
    @PluginMethod
    fun openSettings(call: PluginCall) {
        val intent = when (sdkStatus()) {
            "available" ->
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                    Intent("android.health.connect.action.MANAGE_HEALTH_PERMISSIONS")
                        .putExtra(Intent.EXTRA_PACKAGE_NAME, context.packageName)
                } else {
                    Intent(HealthConnectClient.ACTION_HEALTH_CONNECT_SETTINGS)
                }
            "not_installed", "update_required" ->
                Intent(Intent.ACTION_VIEW, Uri.parse(PLAY_STORE_PAGE))
                    .setPackage("com.android.vending")
                    .putExtra("overlay", true)
                    .putExtra("callerId", context.packageName)
            else -> {
                call.reject("Health Connect is not available on this phone", "UNAVAILABLE")
                return
            }
        }
        try {
            activity.startActivity(intent)
            call.resolve()
        } catch (e: ActivityNotFoundException) {
            call.reject("Could not open Health Connect", e)
        }
    }
}
