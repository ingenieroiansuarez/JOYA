package dev.aurea.renderbench

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Color
import android.graphics.Typeface
import android.os.BatteryManager
import android.os.Build
import android.os.Bundle
import android.os.Debug
import android.os.PowerManager
import android.os.SystemClock
import android.util.Half
import android.view.Choreographer
import android.view.Gravity
import android.view.Surface
import android.view.SurfaceView
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.google.android.filament.Camera
import com.google.android.filament.Engine
import com.google.android.filament.EntityManager
import com.google.android.filament.IndirectLight
import com.google.android.filament.Renderer
import com.google.android.filament.Scene
import com.google.android.filament.Skybox
import com.google.android.filament.SwapChain
import com.google.android.filament.Texture
import com.google.android.filament.View as FView
import com.google.android.filament.Viewport
import com.google.android.filament.android.DisplayHelper
import com.google.android.filament.android.UiHelper
import com.google.android.filament.gltfio.AssetLoader
import com.google.android.filament.gltfio.FilamentAsset
import com.google.android.filament.gltfio.FilamentInstance
import com.google.android.filament.gltfio.Gltfio
import com.google.android.filament.gltfio.ResourceLoader
import com.google.android.filament.gltfio.UbershaderProvider
import com.google.android.filament.utils.IBLPrefilterContext
import com.google.android.filament.utils.Utils
import org.json.JSONArray
import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import java.time.Instant
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Native Filament counterpart of tools/render-bench (WebView/Three.js), for ADR-0003.
 *
 * Same camera, spin, scenes, timing rules and report shape as the web bench so the two JSON
 * reports can be compared field by field. Frame intervals are measured between consecutive
 * frames Filament actually rendered (beginFrame() == true), using the Choreographer vsync
 * timestamps, which is the native equivalent of requestAnimationFrame timestamps.
 */
class MainActivity : Activity(), Choreographer.FrameCallback {

    companion object {
        init {
            Utils.init()   // loads filament-jni and filament-utils-jni
            Gltfio.init()  // loads gltfio-jni
        }

        const val TOOL = "aurea-render-bench-android/0.1.5"
        const val FILAMENT_VERSION = "1.79.0"
        const val ASSET = "showcase.glb"
        const val SCENE_SECONDS = 15.0
        const val WARMUP_SECONDS = 2.0
        val RAMP_COUNTS = intArrayOf(100, 225, 400, 900, 1600, 2500)
        const val GRID_STEP = 0.03f

        // Same render resolution the web bench measured on the Z Flip 7 (canvas 984x738, DPR 3),
        // so both paths shade the same number of pixels.
        const val SURFACE_W = 984
        const val SURFACE_H = 738
    }

    private val t0 = SystemClock.elapsedRealtimeNanos()

    // Filament core
    private lateinit var engine: Engine
    private lateinit var renderer: Renderer
    private lateinit var scene: Scene
    private lateinit var view: FView
    private lateinit var camera: Camera
    private var cameraEntity = 0
    private var swapChain: SwapChain? = null
    private lateinit var uiHelper: UiHelper
    private lateinit var displayHelper: DisplayHelper
    private lateinit var surfaceView: SurfaceView

    // Lighting
    private var equirect: Texture? = null
    private var envCubemap: Texture? = null
    private var reflections: Texture? = null
    private var indirectLight: IndirectLight? = null
    private var skybox: Skybox? = null
    private var iblContext: IBLPrefilterContext? = null
    private var iblToCube: IBLPrefilterContext.EquirectangularToCubemap? = null
    private var iblSpecular: IBLPrefilterContext.SpecularFilter? = null
    private var cameraRecoveries = 0
    private var surfaceW = SURFACE_W
    private var surfaceH = SURFACE_H
    private var cameraEye = doubleArrayOf(0.0, 0.012, 0.055)

    // glTF
    private lateinit var materialProvider: UbershaderProvider
    private lateinit var assetLoader: AssetLoader
    private lateinit var resourceLoader: ResourceLoader
    private lateinit var glbBytes: ByteArray
    private lateinit var single: FilamentAsset
    private var many: FilamentAsset? = null
    private var manyInstances: Array<FilamentInstance> = emptyArray()
    private var manyLoadMs = 0.0
    private var parseMs = 0.0
    private var ringTriangles = 0
    private var gemTriangles = 0
    private var glbSha256 = ""

    // Scene state
    private var sceneEntities = IntArray(0)
    private var spinRoots = IntArray(0)
    private var spinOffsets = FloatArray(0)   // x,y per root
    private var currentRings = 0
    private var currentRenderables = 0
    private var currentTriangles = 0
    private val matrix = FloatArray(16)

    // UI
    private lateinit var hud: TextView
    private lateinit var status: TextView
    private lateinit var table: TextView
    private lateinit var jsonView: TextView
    private lateinit var runButton: Button
    private lateinit var copyButton: Button

    // Timing
    private val choreographer: Choreographer by lazy { Choreographer.getInstance() }
    private var firstFrameMs: Double? = null
    private var measuring: Measurement? = null
    private var calibrating: Calibration? = null
    private var report: JSONObject? = null
    private var lastHudNanos = 0L
    private var initFailed = false
    private var ready = false
    private var diagnostic: String? = null
    private var renderStagePending: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        buildUi()
        installJavaCrashMarker()
        val previousCrash = previousCrashReport()
        if (previousCrash != null) {
            // Do not start Filament again: a native abort would close the app before anything is shown.
            status.text = "La app se cerró la vez anterior. Toca \"Copiar diagnóstico\", pégalo en el chat y luego toca \"Reintentar\"."
            jsonView.text = previousCrash
            diagnostic = previousCrash
            runButton.text = "Reintentar"
            copyButton.text = "Copiar diagnóstico"
            copyButton.isEnabled = true
            return
        }
        initFilament()
    }

    private fun initFilament() {
        try {
            stage("setupFilament"); setupFilament()
            stage("loadAssets"); loadAssets()
            stage("buildLighting"); buildLighting()
            stage("lit cameraOk=${engine.getCameraComponent(cameraEntity)?.nativeObject == camera.nativeObject}")
            buildScene("vitrina", null)
        } catch (t: Throwable) {
            stage("java-exception-init")
            runButton.isEnabled = false
            status.text = "Error al iniciar: ${t.javaClass.simpleName}: ${t.message}"
            jsonView.text = android.util.Log.getStackTraceString(t)
            initFailed = true
            return
        }
        ready = true
        choreographer.removeFrameCallback(this)
        choreographer.postFrameCallback(this)
        status.text = "Listo. GLB ${"%.1f".format(glbBytes.size / 1024.0)} KB, " +
            "${ringTriangles + gemTriangles} triángulos, parseado en ${"%.1f".format(parseMs)} ms. " +
            "Backend: ${engine.backend.name}."
    }

    // ---------------------------------------------------------------- UI

    private fun buildUi() {
        val gold = Color.rgb(0xE6, 0xB9, 0x5C)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.rgb(0x12, 0x11, 0x10))
            setPadding(32, 48, 32, 32)
        }
        root.addView(TextView(this).apply {
            text = "AUREA · Banco de render nativo (Filament $FILAMENT_VERSION)"
            setTextColor(gold); textSize = 17f; typeface = Typeface.DEFAULT_BOLD
        })
        root.addView(TextView(this).apply {
            text = "Prueba de factibilidad P0-04. Mismas escenas que la versión web. No toques la pantalla durante la medición."
            setTextColor(Color.rgb(0xB8, 0xB0, 0xA0)); textSize = 13f; setPadding(0, 8, 0, 16)
        })

        val stage = FrameLayout(this)
        surfaceView = SurfaceView(this)
        stage.addView(surfaceView, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        hud = TextView(this).apply {
            text = "—"; setTextColor(gold); textSize = 12f; typeface = Typeface.MONOSPACE
            setBackgroundColor(Color.argb(140, 0, 0, 0)); setPadding(12, 6, 12, 6)
        }
        stage.addView(hud, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.START))
        val width = resources.displayMetrics.widthPixels - 64
        root.addView(stage, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, width * 3 / 4))

        val buttons = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; setPadding(0, 16, 0, 8) }
        runButton = Button(this).apply { text = "Ejecutar la prueba"; setOnClickListener { onRunButton() } }
        copyButton = Button(this).apply { text = "Copiar resultados"; isEnabled = false; setOnClickListener { onCopyButton() } }
        buttons.addView(runButton); buttons.addView(copyButton)
        root.addView(buttons)

        status = TextView(this).apply { setTextColor(Color.WHITE); textSize = 14f; setPadding(0, 4, 0, 8) }
        root.addView(status)
        table = TextView(this).apply { setTextColor(Color.rgb(0xE8, 0xE0, 0xD0)); textSize = 12f; typeface = Typeface.MONOSPACE }
        root.addView(table)
        jsonView = TextView(this).apply {
            setTextColor(Color.rgb(0x9A, 0x92, 0x85)); textSize = 10f; typeface = Typeface.MONOSPACE
            setTextIsSelectable(true); setPadding(0, 16, 0, 0)
        }
        root.addView(jsonView)

        setContentView(ScrollView(this).apply { isFillViewport = true; addView(root) })
    }

    // ---------------------------------------------------------------- Filament setup

    private fun setupFilament() {
        engine = Engine.create()
        renderer = engine.createRenderer()
        scene = engine.createScene()
        view = engine.createView()
        cameraEntity = EntityManager.get().create()
        camera = engine.createCamera(cameraEntity)
        view.scene = scene
        view.camera = camera

        // Match the web bench: 4x MSAA (antialias: true), no FXAA, ACES tone mapping (Filament default).
        view.antiAliasing = FView.AntiAliasing.NONE
        view.multiSampleAntiAliasingOptions = FView.MultiSampleAntiAliasingOptions().apply {
            enabled = true; sampleCount = 4
        }
        // Exposure 1.0 so the procedural environment below is used at face value (no physical camera).
        camera.setExposure(1.0f)
        stage("camera created entity=$cameraEntity")

        // Background 0x121110 like the web bench (linear values; tone mapping applies to the skybox).
        skybox = Skybox.Builder().color(0.0060f, 0.0056f, 0.0050f, 1.0f).build(engine)
        scene.skybox = skybox

        displayHelper = DisplayHelper(this)
        uiHelper = UiHelper(UiHelper.ContextErrorPolicy.DONT_CHECK)
        uiHelper.renderCallback = object : UiHelper.RendererCallback {
            override fun onNativeWindowChanged(surface: Surface) {
                swapChain?.let { engine.destroySwapChain(it) }
                swapChain = engine.createSwapChain(surface)
                @Suppress("DEPRECATION")
                displayHelper.attach(renderer, surfaceView.display ?: windowManager.defaultDisplay)
            }

            override fun onDetachedFromSurface() {
                displayHelper.detach()
                swapChain?.let {
                    engine.destroySwapChain(it)
                    engine.flushAndWait()
                    swapChain = null
                }
            }

            override fun onResized(width: Int, height: Int) {
                view.viewport = Viewport(0, 0, width, height)
                surfaceW = width; surfaceH = height
                applyProjection()
            }
        }
        uiHelper.setDesiredSize(SURFACE_W, SURFACE_H)
        uiHelper.attachTo(surfaceView)
    }

    private fun loadAssets() {
        glbBytes = assets.open(ASSET).use { it.readBytes() }
        glbSha256 = MessageDigest.getInstance("SHA-256").digest(glbBytes).joinToString("") { "%02x".format(it) }
        countTriangles()

        materialProvider = UbershaderProvider(engine)
        assetLoader = AssetLoader(engine, materialProvider, EntityManager.get())
        resourceLoader = ResourceLoader(engine)

        val start = System.nanoTime()
        single = assetLoader.createAsset(directBuffer(glbBytes))
            ?: error("gltfio could not parse $ASSET")
        resourceLoader.loadResources(single)
        single.releaseSourceData()
        parseMs = (System.nanoTime() - start) / 1e6
    }

    /** Instanced copy for the stress scene and the ramp, created only when first needed. */
    private fun ensureMany() {
        if (many != null) return
        val start = System.nanoTime()
        val slots = arrayOfNulls<FilamentInstance>(RAMP_COUNTS.last())
        val asset = assetLoader.createInstancedAsset(directBuffer(glbBytes), slots)
            ?: error("gltfio could not instance $ASSET")
        resourceLoader.loadResources(asset)
        asset.releaseSourceData()
        many = asset
        manyInstances = slots.map { it!! }.toTypedArray()
        manyLoadMs = (System.nanoTime() - start) / 1e6
    }

    private fun directBuffer(bytes: ByteArray): ByteBuffer =
        ByteBuffer.allocateDirect(bytes.size).order(ByteOrder.nativeOrder()).apply { put(bytes); flip() }

    /** Triangle counts straight from the GLB's JSON chunk (Filament does not report per-frame stats in Java). */
    private fun countTriangles() {
        val bb = ByteBuffer.wrap(glbBytes).order(ByteOrder.LITTLE_ENDIAN)
        val jsonLen = bb.getInt(12)
        val gltf = JSONObject(String(glbBytes, 20, jsonLen, Charsets.UTF_8))
        val accessors = gltf.getJSONArray("accessors")
        val meshes = gltf.getJSONArray("meshes")
        for (i in 0 until meshes.length()) {
            val mesh = meshes.getJSONObject(i)
            val prims = mesh.getJSONArray("primitives")
            var tris = 0
            for (p in 0 until prims.length()) {
                tris += accessors.getJSONObject(prims.getJSONObject(p).getInt("indices")).getInt("count") / 3
            }
            if (mesh.getString("name") == "gem") gemTriangles += tris else ringTriangles += tris
        }
    }

    /**
     * Procedural studio environment (no licensed HDRI): dim room, bright ceiling softbox and two
     * side panels, roughly what Three's RoomEnvironment gives the web bench. Prefiltered on the GPU
     * with IBLPrefilterContext.
     */
    private fun buildLighting() {
        val w = 512
        val h = 256
        val buf = ByteBuffer.allocateDirect(w * h * 4 * 2).order(ByteOrder.nativeOrder())
        for (y in 0 until h) {
            val lat = (0.5 - (y + 0.5) / h) * PI            // +pi/2 = up
            for (x in 0 until w) {
                val lon = ((x + 0.5) / w - 0.5) * 2 * PI
                val dy = sin(lat)
                var v = if (dy >= 0) 0.22 + 0.18 * dy else 0.10 + 0.04 * (1 + dy)
                if (lat > PI * 0.36) v = 7.0                                        // ceiling softbox
                if (abs(lat) < PI * 0.14 && abs(abs(lon) - PI / 2) < PI * 0.10) v = 4.0 // side panels
                if (lat in (PI * 0.05)..(PI * 0.20) && abs(lon - PI) < PI * 0.07) v = 2.5 // back rim
                val warm = 1.0 + 0.04 * cos(lon)
                buf.putShort(Half.toHalf((v * warm).toFloat()))
                buf.putShort(Half.toHalf(v.toFloat()))
                buf.putShort(Half.toHalf((v / warm).toFloat()))
                buf.putShort(Half.toHalf(1f))
            }
        }
        buf.flip()
        // IBLPrefilterContext requires the full mip chain allocated (log2(width)+1 levels) and
        // generates the mips itself, so the texture must be GEN_MIPMAPPABLE.
        val levels = 32 - Integer.numberOfLeadingZeros(w)
        val eq = Texture.Builder()
            .width(w).height(h).levels(levels)
            .usage(Texture.Usage.DEFAULT or Texture.Usage.GEN_MIPMAPPABLE)
            .sampler(Texture.Sampler.SAMPLER_2D)
            .format(Texture.InternalFormat.RGBA16F)
            .build(engine)
        eq.setImage(engine, 0, Texture.PixelBufferDescriptor(buf, Texture.Format.RGBA, Texture.Type.HALF))
        equirect = eq

        val ctx = IBLPrefilterContext(engine)
        val toCube = IBLPrefilterContext.EquirectangularToCubemap(ctx)
        val specular = IBLPrefilterContext.SpecularFilter(ctx)
        val cube = toCube.run(eq)
        val refl = specular.run(cube)
        // Kept alive until onDestroy: destroying the context right away destroys entities and
        // components mid-setup, and on Filament 1.79 the view's camera was later found freed
        // (SIGSEGV in FView::computeCameraInfo on the Z Flip 7).
        iblContext = ctx; iblToCube = toCube; iblSpecular = specular
        envCubemap = cube
        reflections = refl
        indirectLight = IndirectLight.Builder().reflections(refl).intensity(1.0f).build(engine)
        scene.indirectLight = indirectLight
    }

    // ---------------------------------------------------------------- Scenes

    private fun buildScene(kind: String, count: Int?) {
        val n = count ?: if (kind == "estres") 25 else 1
        stage("scene:$kind:$n")
        if (sceneEntities.isNotEmpty()) scene.removeEntities(sceneEntities)
        val entities = ArrayList<Int>()
        val roots = IntArray(n)
        val offsets = FloatArray(n * 2)
        val grid = ceil(sqrt(n.toDouble())).toInt()
        if (n == 1) {
            val gem = single.getFirstEntityByName("gem")
            single.entities.filter { kind != "base" || it != gem }.forEach { entities.add(it) }
            roots[0] = single.root
        } else {
            ensureMany()
            for (i in 0 until n) {
                val inst = manyInstances[i]
                inst.entities.forEach { entities.add(it) }
                roots[i] = inst.root
                offsets[i * 2] = ((i % grid) - (grid - 1) / 2f) * GRID_STEP
                offsets[i * 2 + 1] = ((i / grid) - (grid - 1) / 2f) * GRID_STEP
            }
        }
        sceneEntities = entities.toIntArray()
        scene.addEntities(sceneEntities)
        spinRoots = roots
        spinOffsets = offsets
        currentRings = n
        val withGem = kind != "base"
        currentRenderables = n * (if (withGem) 2 else 1)
        currentTriangles = n * (ringTriangles + if (withGem) gemTriangles else 0)
        renderStagePending = "$kind:$n"
        val camZ = if (n > 1) max(0.26, grid * GRID_STEP * 1.9) else 0.055
        cameraEye = doubleArrayOf(0.0, 0.012, camZ)
        applyLookAt()
    }

    private fun applyProjection() =
        camera.setProjection(35.0, surfaceW.toDouble() / surfaceH, 0.001, 10.0, Camera.Fov.VERTICAL)

    private fun applyLookAt() =
        camera.lookAt(cameraEye[0], cameraEye[1], cameraEye[2], 0.0, 0.0, 0.0, 0.0, 1.0, 0.0)

    /**
     * Guard for the crash seen on the Z Flip 7: if the engine no longer has our camera component,
     * rendering would dereference a freed FCamera. Record it and rebuild the camera instead.
     */
    private fun ensureCamera() {
        val live = engine.getCameraComponent(cameraEntity)
        if (live != null && live.nativeObject == camera.nativeObject) return
        val em = EntityManager.get()
        val alive = em.isAlive(cameraEntity)
        cameraRecoveries++
        stage("camera-lost alive=$alive component=${live != null} n=$cameraRecoveries")
        if (!alive) cameraEntity = em.create()
        camera = live ?: engine.createCamera(cameraEntity)
        camera.setExposure(1.0f)
        applyProjection(); applyLookAt()
        view.camera = camera
    }

    /** Same motion as the web bench: rotation.y = t/2400 (t in ms), rotation.x = 0.35 (XYZ order). */
    private fun spin(frameTimeNanos: Long) {
        val tm = engine.transformManager
        // Relative to app start and reduced mod 360 in double precision, so the Float angle keeps
        // full resolution whatever the device uptime is.
        val ry = (Math.toDegrees(((frameTimeNanos - t0) / 1e6) / 2400.0) % 360.0).toFloat()
        val rx = Math.toDegrees(0.35).toFloat()
        for (i in spinRoots.indices) {
            android.opengl.Matrix.setIdentityM(matrix, 0)
            android.opengl.Matrix.translateM(matrix, 0, spinOffsets[i * 2], spinOffsets[i * 2 + 1], 0f)
            android.opengl.Matrix.rotateM(matrix, 0, rx, 1f, 0f, 0f)
            android.opengl.Matrix.rotateM(matrix, 0, ry, 0f, 1f, 0f)
            tm.setTransform(tm.getInstance(spinRoots[i]), matrix)
        }
    }

    // ---------------------------------------------------------------- Frame loop

    override fun onResume() {
        super.onResume()
        if (!ready) return
        choreographer.removeFrameCallback(this)
        choreographer.postFrameCallback(this)
    }

    override fun onPause() {
        super.onPause()
        choreographer.removeFrameCallback(this)
        if (measuring != null || calibrating != null) abortRun("La prueba se interrumpió porque la app pasó a segundo plano.")
    }

    override fun doFrame(frameTimeNanos: Long) {
        choreographer.postFrameCallback(this)

        calibrating?.let { cal ->
            // Unloaded loop: no rendering, only vsync cadence, so a slow scene is never taken as the refresh interval.
            cal.tick(frameTimeNanos)
            if (cal.done) { calibrating = null; onCalibrated(cal.medianMs()) }
            return
        }

        spin(frameTimeNanos)
        val sc = swapChain ?: return
        if (!uiHelper.isReadyToRender) return
        ensureCamera()
        val pendingStage = renderStagePending
        if (pendingStage != null) stage("render:$pendingStage")
        val cpuStart = System.nanoTime()
        if (renderer.beginFrame(sc, frameTimeNanos)) {
            renderer.render(view)
            renderer.endFrame()
            if (pendingStage != null) { stage("ok:$pendingStage"); renderStagePending = null }
            val cpuMs = (System.nanoTime() - cpuStart) / 1e6
            if (firstFrameMs == null) firstFrameMs = (SystemClock.elapsedRealtimeNanos() - t0) / 1e6
            measuring?.onRendered(frameTimeNanos, cpuMs)
        } else {
            measuring?.onSkipped(frameTimeNanos)
        }
        measuring?.let { m ->
            // HUD refreshed 4x/s: a TextView change per frame would force a layout pass every frame.
            if (frameTimeNanos - lastHudNanos > 250_000_000L) { hud.text = m.hudText(); lastHudNanos = frameTimeNanos }
            if (m.finished(frameTimeNanos)) { measuring = null; m.onDone(m.result()) }
        }
    }

    // ---------------------------------------------------------------- Measurement

    private inner class Calibration {
        private val deltas = ArrayList<Double>()
        private var last = -1L
        private var start = -1L
        var done = false
        fun tick(t: Long) {
            if (start < 0) start = t
            if (last >= 0) deltas.add((t - last) / 1e6)
            last = t
            if ((t - start) / 1e9 >= 1.5) done = true
        }
        fun medianMs(): Double = pct(deltas, 0.5)
    }

    private inner class Measurement(
        val kind: String, val count: Int?, val seconds: Double, val warmup: Double,
        val onDone: (JSONObject) -> Unit,
    ) {
        private var start = -1L
        private var lastRendered = -1L
        private val times = ArrayList<Double>()
        private val cpu = ArrayList<Double>()
        private var skipped = 0

        private fun elapsed(t: Long) = if (start < 0) 0.0 else (t - start) / 1e9

        fun onRendered(t: Long, cpuMs: Double) {
            if (start < 0) start = t
            if (lastRendered >= 0 && elapsed(t) > warmup) { times.add((t - lastRendered) / 1e6); cpu.add(cpuMs) }
            lastRendered = t
        }

        fun onSkipped(t: Long) {
            if (start < 0) start = t
            if (elapsed(t) > warmup) skipped++
        }

        fun finished(t: Long) = start >= 0 && elapsed(t) >= seconds

        fun hudText(): String {
            val left = max(0.0, seconds - (if (lastRendered < 0) 0.0 else elapsed(lastRendered)))
            val fps = if (times.isEmpty()) "—" else "%.0f".format(1000.0 / times.last())
            val rings = if (count != null) "$count anillos · " else ""
            return "$kind · $rings${"%.0f".format(left)} s · $fps fps"
        }

        fun result(): JSONObject {
            val total = times.sum()
            return JSONObject().apply {
                put("scene", kind)
                put("rings", currentRings)
                put("frames", times.size)
                put("fpsMean", round1(if (total > 0) times.size / (total / 1000.0) else 0.0))
                put("p50ms", round2(pct(times, 0.5)))
                put("p95ms", round2(pct(times, 0.95)))
                put("p99ms", round2(pct(times, 0.99)))
                put("over33msPct", round1(if (times.isEmpty()) 0.0 else 100.0 * times.count { it > 33.4 } / times.size))
                put("skippedFrames", skipped)
                put("cpuSubmitP50ms", round2(pct(cpu, 0.5)))
                put("cpuSubmitP95ms", round2(pct(cpu, 0.95)))
                put("renderables", currentRenderables)
                put("trianglesPerFrame", currentTriangles)
            }
        }
    }

    // Run state
    private var cadenceMs = 0.0
    private val results = ArrayList<JSONObject>()
    private val ramp = ArrayList<JSONObject>()
    private var runStartMs = 0L
    private var batteryStart: JSONObject? = null
    private var thermalStart: JSONObject? = null

    private fun startRun() {
        runButton.isEnabled = false; copyButton.isEnabled = false
        results.clear(); ramp.clear(); table.text = ""; jsonView.text = ""
        batteryStart = battery(); thermalStart = thermal(); runStartMs = System.currentTimeMillis()
        status.text = "Midiendo la cadencia de la pantalla…"
        calibrating = Calibration()
    }

    private fun onCalibrated(cadence: Double) {
        cadenceMs = cadence
        runScenes(listOf("base", "vitrina", "estres"))
    }

    private fun runScenes(queue: List<String>) {
        if (queue.isEmpty()) { runRamp(0); return }
        val kind = queue.first()
        status.text = "Midiendo $kind… no toques la pantalla."
        buildScene(kind, null)
        measuring = Measurement(kind, null, SCENE_SECONDS, WARMUP_SECONDS) { r ->
            results.add(r); paintTable(); runScenes(queue.drop(1))
        }
    }

    private fun runRamp(step: Int) {
        if (step >= RAMP_COUNTS.size) { finishRun(); return }
        val count = RAMP_COUNTS[step]
        status.text = "Buscando el límite: $count anillos…"
        buildScene("limite", count)
        measuring = Measurement("limite", count, 6.0, 1.0) { r ->
            ramp.add(r); paintTable()
            if (r.getDouble("p95ms") > cadenceMs * 1.1) finishRun() else runRamp(step + 1)
        }
    }

    private fun sustainedRings(): Int =
        ramp.filter { it.getDouble("p95ms") <= cadenceMs * 1.1 }.lastOrNull()?.getInt("rings") ?: 0

    private fun finishRun() {
        val mem = Debug.MemoryInfo().also { Debug.getMemoryInfo(it) }
        val r = JSONObject().apply {
            put("tool", TOOL)
            put("path", "native-filament")
            put("filament", FILAMENT_VERSION)
            put("measuredAt", Instant.now().toString())
            put("asset", JSONObject().apply {
                put("file", "$ASSET (ring.classic 18/4/1.8 mm + gema, tools/render-bench/scene)")
                put("bytes", glbBytes.size)
                put("sha256", glbSha256)
                put("triangles", ringTriangles + gemTriangles)
                put("ringTriangles", ringTriangles)
                put("gemTriangles", gemTriangles)
                put("parseMs", round1(parseMs))
                put("instancedLoadMs", round1(manyLoadMs))
                put("instancedCount", manyInstances.size)
            })
            put("firstFrameMs", firstFrameMs?.let { Math.round(it) } ?: JSONObject.NULL)
            put("device", deviceInfo())
            put("memory", JSONObject().apply {
                put("totalPssMB", round1(mem.totalPss / 1024.0))
                put("nativeHeapMB", round1(Debug.getNativeHeapAllocatedSize() / 1048576.0))
            })
            put("battery", JSONObject().apply {
                put("start", batteryStart); put("end", battery())
                put("seconds", (System.currentTimeMillis() - runStartMs) / 1000)
            })
            put("thermal", JSONObject().apply { put("start", thermalStart); put("end", thermal()) })
            put("sceneSeconds", SCENE_SECONDS)
            put("warmupSeconds", WARMUP_SECONDS)
            put("displayCadenceMs", round2(cadenceMs))
            put("cameraRecoveries", cameraRecoveries)
            put("results", JSONArray(results))
            put("ramp", JSONObject().apply {
                put("secondsPerStep", 6)
                put("criterion", "p95 <= 1.1 x display cadence")
                put("maxSustainedRings", sustainedRings())
                put("steps", JSONArray(ramp))
            })
            put("notes", JSONArray(listOf(
                "Intervalos entre frames renderizados (beginFrame=true) con timestamps de vsync de Choreographer.",
                "renderables y trianglesPerFrame se calculan desde el GLB; Filament no expone draw calls en Java.",
                "Entorno IBL procedural (sin HDRI), prefiltrado con IBLPrefilterContext; exposición 1.0.",
            )))
        }
        report = r
        jsonView.text = r.toString(2)
        status.text = "Terminado. Copia los resultados y pégalos en el chat."
        hud.text = "terminado"
        runButton.isEnabled = true; copyButton.isEnabled = true
        buildScene("vitrina", null)
    }

    private fun abortRun(message: String) {
        measuring = null; calibrating = null
        status.text = message
        runButton.isEnabled = true
        buildScene("vitrina", null)
    }

    private fun paintTable() {
        val sb = StringBuilder("Escena       FPS    p50    p95   >33ms\n")
        for (r in results) sb.append(row(r.getString("scene"), r))
        val sustained = sustainedRings()
        ramp.lastOrNull()?.let {
            sb.append(row("límite ${it.getInt("rings")}", it))
            sb.append(if (ramp.size > 0) "Límite sostenido: $sustained anillos + gemas\n" else "")
        }
        table.text = sb.toString()
    }

    private fun row(name: String, r: JSONObject) =
        "%-12s %5.1f %6.2f %6.2f %5.1f%%\n".format(name, r.getDouble("fpsMean"), r.getDouble("p50ms"), r.getDouble("p95ms"), r.getDouble("over33msPct"))


    // ---------------------------------------------------------------- Device facts

    private fun deviceInfo(): JSONObject = JSONObject().apply {
        put("manufacturer", Build.MANUFACTURER)
        put("model", Build.MODEL)
        put("device", Build.DEVICE)
        put("hardware", Build.HARDWARE)
        if (Build.VERSION.SDK_INT >= 31) { put("socManufacturer", Build.SOC_MANUFACTURER); put("socModel", Build.SOC_MODEL) }
        put("android", Build.VERSION.RELEASE)
        put("sdkInt", Build.VERSION.SDK_INT)
        put("filamentBackend", engine.backend.name)
        val display = surfaceView.display
        if (display != null) {
            put("refreshRateHz", round1(display.refreshRate.toDouble()))
            put("supportedRefreshRatesHz", JSONArray(display.supportedModes.map { round1(it.refreshRate.toDouble()) }.distinct().sorted()))
        }
        put("surfacePx", JSONArray(listOf(SURFACE_W, SURFACE_H)))
        put("msaaSamples", 4)
        put("cores", Runtime.getRuntime().availableProcessors())
        val am = getSystemService(Context.ACTIVITY_SERVICE) as android.app.ActivityManager
        val mi = android.app.ActivityManager.MemoryInfo().also { am.getMemoryInfo(it) }
        put("totalMemGB", round1(mi.totalMem / 1073741824.0))
    }

    private fun battery(): JSONObject {
        val bm = getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        val sticky = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val plugged = (sticky?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0) != 0
        return JSONObject().apply {
            put("level", bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY) / 100.0)
            put("charging", plugged)
            sticky?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Int.MIN_VALUE)?.takeIf { it != Int.MIN_VALUE }
                ?.let { put("temperatureC", it / 10.0) }
        }
    }

    private fun thermal(): JSONObject {
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        return JSONObject().apply {
            if (Build.VERSION.SDK_INT >= 29) put("status", pm.currentThermalStatus)
            if (Build.VERSION.SDK_INT >= 30) {
                val headroom = pm.getThermalHeadroom(0)
                if (!headroom.isNaN()) put("headroom", round2(headroom.toDouble()))
            }
        }
    }

    // ---------------------------------------------------------------- Diagnostics

    private val diagPrefs by lazy { getSharedPreferences("diag", Context.MODE_PRIVATE) }

    /** Last step reached, written synchronously so it survives a native abort. */
    private fun stage(name: String) {
        // Also keep the last few steps, so the report shows how the app got there.
        val trail = (diagPrefs.getString("trail", "")!!.split(" | ").filter { it.isNotEmpty() } + name).takeLast(10)
        diagPrefs.edit().putString("stage", name).putString("trail", trail.joinToString(" | "))
            .putLong("stageAt", System.currentTimeMillis()).commit()
    }

    private fun installJavaCrashMarker() {
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            try {
                diagPrefs.edit().putString("javaCrash", android.util.Log.getStackTraceString(error).take(4000)).commit()
            } catch (ignored: Throwable) {}
            previous?.uncaughtException(thread, error)
        }
    }

    /**
     * Report of this app's last abnormal exit: Android's exit reason (API 30+), the last step the
     * app reached, any Java stack trace, and the app's own log lines from that process (Filament
     * writes its precondition failures there). Null when the last exit was normal or already retried.
     */
    private fun previousCrashReport(): String? {
        if (Build.VERSION.SDK_INT < 30) return null
        val am = getSystemService(Context.ACTIVITY_SERVICE) as android.app.ActivityManager
        val info = am.getHistoricalProcessExitReasons(packageName, 0, 1).firstOrNull() ?: return null
        val crash = info.reason == android.app.ApplicationExitInfo.REASON_CRASH ||
            info.reason == android.app.ApplicationExitInfo.REASON_CRASH_NATIVE ||
            info.reason == android.app.ApplicationExitInfo.REASON_ANR
        if (!crash || diagPrefs.getLong("retriedExit", 0L) == info.timestamp) return null
        val reason = when (info.reason) {
            android.app.ApplicationExitInfo.REASON_CRASH -> "CRASH (Java)"
            android.app.ApplicationExitInfo.REASON_CRASH_NATIVE -> "CRASH_NATIVE"
            else -> "ANR"
        }
        val log = try {
            val proc = Runtime.getRuntime().exec(arrayOf("logcat", "-d", "-v", "time", "--pid=${info.pid}"))
            val lines = proc.inputStream.bufferedReader().readLines()
            val useful = Regex("Filament|gltfio|FEngine|Precondition|Panic|ibl|EGL|GLES|libc")
            (lines.filter { useful.containsMatchIn(it) }.takeLast(40) + listOf("…") + lines.takeLast(4))
                .joinToString("\n")
        } catch (t: Throwable) { "logcat no disponible: ${t.message}" }
        pendingRetryExit = info.timestamp
        return buildString {
            append("AUREA render bench $TOOL — diagnóstico\n")
            append("motivo=$reason estado=${info.status} hora=${Instant.ofEpochMilli(info.timestamp)}\n")
            append("descripción=${info.description}\n")
            append("última etapa=${diagPrefs.getString("stage", "?")}\n")
            append("etapas=${diagPrefs.getString("trail", "?")}\n")
            append("dispositivo=${Build.MANUFACTURER} ${Build.MODEL} Android ${Build.VERSION.RELEASE}\n")
            diagPrefs.getString("javaCrash", null)?.let { append("\nJava:\n$it\n") }
            // Some builds report a SIGSEGV as REASON_CRASH, so always try the tombstone.
            if (Build.VERSION.SDK_INT >= 31) {
                append("\nbacktrace:\n${nativeBacktrace(info)}\n")
            }
            append("\nlog:\n$log")
        }
    }

    private var pendingRetryExit = 0L

    /**
     * Crashing thread's backtrace from the tombstone Android keeps for this app (API 31+), decoded
     * from its protobuf (system/core/debuggerd/proto/tombstone.proto) without extra dependencies.
     */
    private fun nativeBacktrace(info: android.app.ApplicationExitInfo): String = try {
        val bytes = info.traceInputStream?.use { it.readBytes() } ?: return "sin tombstone"
        val top = Proto(bytes).fields()
        val tid = top.firstOrNull { it.first == 6 }?.second as? Long
        val abort = top.firstOrNull { it.first == 14 }?.let { Proto.str(it.second) }
        val out = StringBuilder()
        if (!abort.isNullOrEmpty()) out.append("abort: $abort\n")
        for ((field, value) in top) {
            if (field != 16 || value !is ByteArray) continue          // threads map entry
            val entry = Proto(value).fields()
            val thread = entry.firstOrNull { it.first == 2 }?.second as? ByteArray ?: continue
            val t = Proto(thread).fields()
            if ((t.firstOrNull { it.first == 1 }?.second as? Long) != tid) continue
            var i = 0
            for ((tf, tv) in t) {
                if (tf != 4 || tv !is ByteArray) continue              // current_backtrace frame
                val fr = Proto(tv).fields()
                val relPc = fr.firstOrNull { it.first == 1 }?.second as? Long ?: 0L
                val fn = fr.firstOrNull { it.first == 4 }?.let { Proto.str(it.second) } ?: ""
                val off = fr.firstOrNull { it.first == 5 }?.second as? Long ?: 0L
                val file = fr.firstOrNull { it.first == 6 }?.let { Proto.str(it.second) } ?: ""
                out.append("#%02d pc %08x %s %s\n".format(i++, relPc, file.substringAfterLast('/'),
                    if (fn.isNotEmpty()) "($fn+$off)" else ""))
                if (i >= 24) break
            }
        }
        out.toString().ifEmpty { "tombstone sin frames (${bytes.size} bytes)" }
    } catch (t: Throwable) { "no se pudo leer el tombstone: ${t.message}" }

    /** Minimal protobuf wire-format reader: varints as Long, length-delimited as ByteArray. */
    private class Proto(private val b: ByteArray) {
        private var p = 0
        private fun varint(): Long {
            var shift = 0; var r = 0L
            while (true) {
                val x = b[p++].toInt() and 0xff
                r = r or ((x and 0x7f).toLong() shl shift)
                if (x < 0x80) return r
                shift += 7
            }
        }
        fun fields(): List<Pair<Int, Any>> {
            val out = ArrayList<Pair<Int, Any>>()
            while (p < b.size) {
                val key = varint()
                val field = (key ushr 3).toInt()
                when ((key and 7).toInt()) {
                    0 -> out.add(field to varint())
                    1 -> { p += 8; out.add(field to 0L) }
                    2 -> { val n = varint().toInt(); out.add(field to b.copyOfRange(p, p + n)); p += n }
                    5 -> { p += 4; out.add(field to 0L) }
                    else -> return out
                }
            }
            return out
        }
        companion object {
            fun str(v: Any): String = if (v is ByteArray) String(v, Charsets.UTF_8) else v.toString()
        }
    }

    private fun onRunButton() {
        if (!ready) {
            diagPrefs.edit().putLong("retriedExit", pendingRetryExit).remove("javaCrash").commit()
            runButton.text = "Ejecutar la prueba"
            copyButton.text = "Copiar resultados"; copyButton.isEnabled = false
            diagnostic = null; jsonView.text = ""
            initFilament()
            return
        }
        startRun()
    }

    private fun onCopyButton() {
        val text = diagnostic ?: report?.toString(2) ?: return
        val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText("aurea-render-bench", text))
        status.text = if (diagnostic != null) "Diagnóstico copiado." else "Resultados copiados."
    }

    // ---------------------------------------------------------------- Teardown

    override fun onDestroy() {
        super.onDestroy()
        choreographer.removeFrameCallback(this)
        if (!ready) return
        uiHelper.detach()
        if (sceneEntities.isNotEmpty()) scene.removeEntities(sceneEntities)
        many?.let { assetLoader.destroyAsset(it) }
        assetLoader.destroyAsset(single)
        materialProvider.destroyMaterials()
        materialProvider.destroy()
        assetLoader.destroy()
        resourceLoader.destroy()
        iblToCube?.destroy(); iblSpecular?.destroy(); iblContext?.destroy()
        indirectLight?.let { engine.destroyIndirectLight(it) }
        reflections?.let { engine.destroyTexture(it) }
        envCubemap?.let { engine.destroyTexture(it) }
        equirect?.let { engine.destroyTexture(it) }
        skybox?.let { engine.destroySkybox(it) }
        engine.destroyRenderer(renderer)
        engine.destroyView(view)
        engine.destroyScene(scene)
        engine.destroyCameraComponent(cameraEntity)
        EntityManager.get().destroy(cameraEntity)
        engine.destroy()
    }
}

private fun pct(values: List<Double>, p: Double): Double {
    if (values.isEmpty()) return 0.0
    val s = values.sorted()
    return s[min(s.size - 1, floor(p * s.size).toInt())]
}

private fun round1(v: Double) = Math.round(v * 10) / 10.0
private fun round2(v: Double) = Math.round(v * 100) / 100.0
