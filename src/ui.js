import { MODULE_NAME, defaultSettings } from "../settings.js";
import { openGallery } from "./gallery.js";
import { appendLoraNode, extractLoraChain, findLoaderNodeId, removeLoraNode, setLoraWeight } from "./loraChain.js";
import { resolveRulesText } from "./rewrite.js";
import { getOrLoadWorkflow, getRuntimeWorkflow, markDirty, reloadWorkflow, serializeWorkflow } from "./workflowRuntime.js";

const EXTENSION_FOLDER = `scripts/extensions/third-party/ComfyInject`;

// LoRA Chain panel state. Edits live on the cached runtime workflow, not in settings.
let loraRows = [];
let loraLoaderId = null;
let loraWorkflowFile = "";
let loraLoadToken = 0;
let loraPanelTimer = null;

/**
 * Gets the current live settings from ST.
 * @returns {object}
 */
function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    return extensionSettings[MODULE_NAME];
}

/**
 * Saves the current settings to ST.
 */
function saveSettings() {
    const { saveSettingsDebounced } = SillyTavern.getContext();
    saveSettingsDebounced();
}

/**
 * Fetches the list of available checkpoints from ComfyUI.
 * @returns {Promise<string[]>} Array of checkpoint filenames, or empty array on failure
 */
async function fetchCheckpoints() {
    const settings = getSettings();
    const ret = []
    try {
        const ckpt_response = await fetch(`${settings.comfy_host}/object_info/CheckpointLoaderSimple`);
        if (ckpt_response.ok) {
            const ckpt_data = await ckpt_response.json();
            ret.push(
                ...(ckpt_data?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] ?? [])
            );
        }
        const unet_response = await fetch(`${settings.comfy_host}/object_info/UNETLoader`);
        if (unet_response.ok) {
            const unet_data = await unet_response.json();
            ret.push(
                ...(unet_data?.UNETLoader?.input?.required?.unet_name?.[0] ?? [])
            );
        }
    } catch (err) {
        return [];
    }
    return ret
}

/**
 * Validates that a workflow file exists in the workflows folder.
 * Shows a toastr error if the file doesn't exist, success if it does.
 * @param {string} filename - The workflow filename to validate
 */
async function validateWorkflow(filename) {
    if (!filename || !filename.trim()) return;
    try {
        const response = await fetch(`/${EXTENSION_FOLDER}/workflows/${filename.trim()}`, { method: "HEAD" });
        if (response.ok) {
            toastr.success(`Workflow "${filename}" found!`, "ComfyInject");
        } else {
            toastr.error(`Workflow "${filename}" not found in the workflows folder.`, "ComfyInject");
        }
    } catch (err) {
        toastr.error(`Could not check workflow file.`, "ComfyInject");
    }
}

/**
 * Fetches checkpoints from ComfyUI and populates the dropdown.
 * Called on init and when the arrow button is clicked.
 * @param {boolean} [showToast=true] - Whether to show a toast notification
 */
async function refreshCheckpointList(showToast = true) {
    const checkpoints = await fetchCheckpoints();
    const dropdown = $("#comfyinject_checkpoint_dropdown");
    dropdown.empty();

    if (checkpoints.length > 0) {
        const current = getSettings().checkpoint;
        for (const name of checkpoints) {
            dropdown.append(
                `<div class="comfyinject-checkpoint-option" data-value="${name}" style="padding: 6px 10px; cursor: pointer; ${name === current ? "font-weight: bold;" : ""}">${name}</div>`
            );
        }
        if (showToast) {
            toastr.success(`Found ${checkpoints.length} checkpoint(s)`, "ComfyInject");
        }
    } else if (showToast) {
        toastr.warning("Could not reach ComfyUI. Is it running?", "ComfyInject");
    }
}

/**
 * Escapes a string for safe interpolation into HTML text or attributes.
 * @param {unknown} value - The value to escape
 * @returns {string} The escaped string
 */
function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

/**
 * Tells whether a node id belongs to a LoRA added through the panel.
 * @param {string} id - The workflow node id
 * @returns {boolean}
 */
function isAppendedLoraId(id) {
    return id.startsWith("comfyinject_lora_");
}

/**
 * Dims the Add button and blocks its pointer events when the workflow has no
 * usable loader. The click handler also checks `loraLoaderId`, so a programmatic
 * click cannot append without one.
 * @param {boolean} enabled - Whether adding is allowed
 */
function setLoraAddEnabled(enabled) {
    $("#comfyinject_lora_add")
        .css("opacity", enabled ? 1.0 : 0.4)
        .css("pointer-events", enabled ? "auto" : "none");
}

/**
 * Fetches the LoRA filenames ComfyUI knows about and fills the name datalist.
 * Errors are swallowed silently — the datalist is only a convenience.
 */
async function fetchLoraNames() {
    const settings = getSettings();
    const names = new Set();

    for (const cls of ["LoraLoaderModelOnly", "LoraLoader"]) {
        try {
            const response = await fetch(`${settings.comfy_host}/object_info/${cls}`);
            if (!response.ok) continue;
            const data = await response.json();
            for (const name of data?.[cls]?.input?.required?.lora_name?.[0] ?? []) {
                names.add(name);
            }
        } catch (err) {
            // ComfyUI may be unreachable; the datalist stays empty.
        }
    }

    const datalist = $("#comfyinject_lora_names");
    datalist.empty();
    for (const name of names) {
        datalist.append(`<option value="${escapeHtml(name)}"></option>`);
    }
}

/**
 * Loads the runtime copy of the configured workflow and renders its LoRA chain.
 * Stale async loads are discarded after a newer one starts.
 */
async function loadLoraPanel() {
    const filename = getSettings().workflow || "";
    const token = ++loraLoadToken;

    if (!filename) {
        loraRows = [];
        loraLoaderId = null;
        loraWorkflowFile = "";
        $("#comfyinject_lora_rows").empty();
        $("#comfyinject_lora_status").text("Set a workflow filename.");
        setLoraAddEnabled(false);
        return;
    }

    let entry;
    try {
        entry = await getOrLoadWorkflow(filename);
    } catch (err) {
        if (token !== loraLoadToken) return;
        loraRows = [];
        loraLoaderId = null;
        loraWorkflowFile = filename;
        $("#comfyinject_lora_rows").empty();
        $("#comfyinject_lora_status").text(`Could not read ${filename}.`);
        setLoraAddEnabled(false);
        return;
    }

    if (token !== loraLoadToken) return;

    loraWorkflowFile = filename;
    const loaderId = findLoaderNodeId(entry.workflow);
    if (!loaderId) {
        loraRows = [];
        loraLoaderId = null;
        $("#comfyinject_lora_rows").empty();
        $("#comfyinject_lora_status").text(`No {{CHECKPOINT}} node found in ${filename}.`);
        setLoraAddEnabled(false);
        return;
    }

    loraLoaderId = loaderId;
    setLoraAddEnabled(true);
    renderLoraPanel();
}

/**
 * Renders one row per LoRA in application order from the cached runtime workflow.
 */
function renderLoraPanel() {
    const entry = getRuntimeWorkflow(loraWorkflowFile);
    const container = $("#comfyinject_lora_rows");
    container.empty();

    if (!entry || loraLoaderId === null) {
        loraRows = [];
        updateLoraStatus();
        return;
    }

    loraRows = extractLoraChain(entry.workflow, loraLoaderId).map((node) => ({
        nodeId: node.id,
        name: node.name,
        weight: node.weight,
        appended: isAppendedLoraId(node.id),
    }));

    loraRows.forEach((row, index) => {
        const nameControl = row.appended
            ? `<input type="text" class="text_pole comfyinject-lora-name-input" list="comfyinject_lora_names" data-row-index="${index}" value="${escapeHtml(row.name)}" style="flex: 1;" />`
            : `<span class="comfyinject-lora-name" data-row-index="${index}" title="${escapeHtml(row.name)}" style="flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(row.name)}</span>`;

        container.append(`
            <div class="flex-container flexGap5 alignItemsCenter" style="margin-bottom: 4px;">
                ${nameControl}
                <input
                    type="number"
                    step="0.05"
                    class="text_pole comfyinject-lora-weight"
                    data-row-index="${index}"
                    value="${row.weight}"
                    style="width: 80px;"
                />
                <div class="menu_button comfyinject-lora-remove" data-row-index="${index}" title="Remove this LoRA">
                    <i class="fa-solid fa-xmark"></i>
                </div>
            </div>
        `);
    });

    updateLoraStatus();
}

/**
 * Refreshes the status line from the row count and the cached dirty flag.
 * Empty/error messages set by loadLoraPanel are left untouched.
 */
function updateLoraStatus() {
    const entry = getRuntimeWorkflow(loraWorkflowFile);
    if (loraLoaderId === null || !entry) return;

    const state = entry.dirty ? "unsaved changes" : "matches disk";
    $("#comfyinject_lora_status").text(`${loraRows.length} LoRA(s) · ${state}`);
}

/**
 * Updates the resolution lock inputs visibility and the per-token
 * resolution inputs opacity based on the lock state.
 * @param {boolean} locked - Whether resolution lock is enabled
 */
function updateResolutionLockUI(locked) {
    $("#comfyinject_resolution_lock_inputs").toggle(locked);
    // Dim the per-token inputs when locked so it's obvious they're being ignored
    $("#comfyinject_resolutions").css("opacity", locked ? 0.4 : 1.0);
    $("#comfyinject_resolutions").css("pointer-events", locked ? "none" : "auto");
}

/**
 * Updates the shot lock inputs visibility and the per-token
 * shot tag inputs opacity based on the lock state.
 * @param {boolean} locked - Whether shot lock is enabled
 */
function updateShotLockUI(locked) {
    $("#comfyinject_shot_lock_inputs").toggle(locked);
    // Dim the per-token inputs when locked so it's obvious they're being ignored
    $("#comfyinject_shot_tags").css("opacity", locked ? 0.4 : 1.0);
    $("#comfyinject_shot_tags").css("pointer-events", locked ? "none" : "auto");
}

/**
 * Updates the seed lock inputs visibility and the custom seed input
 * visibility based on the lock state and selected mode.
 * @param {boolean} locked - Whether seed lock is enabled
 */
function updateSeedLockUI(locked) {
    $("#comfyinject_seed_lock_inputs").toggle(locked);
    // Show the custom seed input only when mode is CUSTOM
    const mode = $("#comfyinject_seed_lock_mode").val();
    $("#comfyinject_seed_lock_custom_input").toggle(locked && mode === "CUSTOM");
}


/**
 * Populates all input fields from current settings.
 */
function populateUI() {
    const settings = getSettings();

    $("#comfyinject_host").val(settings.comfy_host);
    $("#comfyinject_checkpoint").val(settings.checkpoint);
    $("#comfyinject_workflow").val(settings.workflow);
    $("#comfyinject_negative_prompt").val(settings.negative_prompt);
    $("#comfyinject_prepend_prompt").val(settings.prepend_prompt);
    $("#comfyinject_append_prompt").val(settings.append_prompt);
    $("#comfyinject_steps").val(settings.steps);
    $("#comfyinject_cfg").val(settings.cfg);
    $("#comfyinject_sampler").val(settings.sampler);
    $("#comfyinject_scheduler").val(settings.scheduler);
    $("#comfyinject_denoise").val(settings.denoise);
    $("#comfyinject_max_poll_attempts").val(settings.max_poll_attempts);

    // Resolution lock
    $("#comfyinject_resolution_lock_enabled").prop("checked", settings.resolution_lock_enabled);
    $("#comfyinject_resolution_lock_width").val(settings.resolution_lock.width);
    $("#comfyinject_resolution_lock_height").val(settings.resolution_lock.height);
    updateResolutionLockUI(settings.resolution_lock_enabled);

    // Populate resolutions
    const resContainer = $("#comfyinject_resolutions");
    resContainer.empty();
    for (const [token, res] of Object.entries(settings.resolutions)) {
        resContainer.append(`
            <div class="flex-container flexGap5 alignItemsCenter" style="margin-bottom: 4px;">
                <label style="width: 80px;">${token}</label>
                <input
                    type="number"
                    class="text_pole comfyinject-res-width"
                    data-token="${token}"
                    value="${res.width}"
                    min="64"
                    max="2048"
                    step="64"
                    style="width: 70px;"
                />
                <span>&times;</span>
                <input
                    type="number"
                    class="text_pole comfyinject-res-height"
                    data-token="${token}"
                    value="${res.height}"
                    min="64"
                    max="2048"
                    step="64"
                    style="width: 70px;"
                />
            </div>
        `);
    }

    // Shot lock
    $("#comfyinject_shot_lock_enabled").prop("checked", settings.shot_lock_enabled);
    const shotSelect = $("#comfyinject_shot_lock_value");
    shotSelect.empty();
    for (const token of Object.keys(settings.shot_tags)) {
        shotSelect.append(`<option value="${token}" ${token === settings.shot_lock ? "selected" : ""}>${token}</option>`);
    }
    updateShotLockUI(settings.shot_lock_enabled);

    // Seed lock
    $("#comfyinject_seed_lock_enabled").prop("checked", settings.seed_lock_enabled);
    $("#comfyinject_seed_lock_mode").val(settings.seed_lock_mode);
    $("#comfyinject_seed_lock_value").val(settings.seed_lock_value);
    updateSeedLockUI(settings.seed_lock_enabled);

    // Marker repair notifications
    $("#comfyinject_repair_toast_mode").val(settings.repair_toast_mode || "failures");

    // AI prompt rewrite
    $("#comfyinject_rewrite_auto_read_preset").prop("checked", settings.rewrite_auto_read_preset !== false);
    $("#comfyinject_rewrite_rules_override").val(settings.rewrite_rules_override ?? "");
    $("#comfyinject_rewrite_context_chars").val(settings.rewrite_context_chars);
    $("#comfyinject_rewrite_max_tokens").val(settings.rewrite_max_tokens);
    $("#comfyinject_rewrite_timeout_ms").val(settings.rewrite_timeout_ms);

    // Populate shot tags
    const shotContainer = $("#comfyinject_shot_tags");
    shotContainer.empty();
    for (const [token, tags] of Object.entries(settings.shot_tags)) {
        shotContainer.append(`
            <div class="flex-container flexGap5 alignItemsCenter" style="margin-bottom: 4px;">
                <label style="width: 80px;">${token}</label>
                <input
                    type="text"
                    class="text_pole comfyinject-shot-tag"
                    data-token="${token}"
                    value="${tags}"
                />
            </div>
        `);
    }
}

/**
 * Wires up all input event listeners.
 */
function wireEvents() {
    // Host
    $("#comfyinject_host").on("input", function () {
        getSettings().comfy_host = $(this).val();
        saveSettings();
    });

    // Checkpoint — text input
    $("#comfyinject_checkpoint").on("input", function () {
        getSettings().checkpoint = $(this).val();
        saveSettings();
    });

    // Checkpoint — arrow button toggles dropdown
    $("#comfyinject_checkpoint_arrow").on("click", function () {
        const dropdown = $("#comfyinject_checkpoint_dropdown");
        if (dropdown.children().length === 0) {
            // No checkpoints fetched yet — trigger a fetch
            refreshCheckpointList(true).then(() => {
                if ($("#comfyinject_checkpoint_dropdown").children().length > 0) {
                    dropdown.show();
                }
            });
        } else {
            dropdown.toggle();
        }
    });

    // Checkpoint — clicking an option fills the text input and closes the dropdown
    $("#comfyinject_checkpoint_dropdown").on("click", ".comfyinject-checkpoint-option", function () {
        const value = $(this).data("value");
        $("#comfyinject_checkpoint").val(value);
        getSettings().checkpoint = value;
        saveSettings();
        $("#comfyinject_checkpoint_dropdown").hide();
    });

    // Checkpoint — hover highlight
    $("#comfyinject_checkpoint_dropdown").on("mouseenter", ".comfyinject-checkpoint-option", function () {
        $(this).css("background", "var(--SmartThemeQuoteColor)");
    }).on("mouseleave", ".comfyinject-checkpoint-option", function () {
        $(this).css("background", "");
    });

    // Close dropdown when clicking outside
    $(document).on("click", function (e) {
        if (!$(e.target).closest("#comfyinject_checkpoint_arrow, #comfyinject_checkpoint_dropdown").length) {
            $("#comfyinject_checkpoint_dropdown").hide();
        }
    });

    // Workflow — debounced validation after typing stops
    let workflowValidateTimer = null;
    $("#comfyinject_workflow").on("input", function () {
        getSettings().workflow = $(this).val();
        saveSettings();

        // Debounce — validate 1.5s after the user stops typing
        clearTimeout(workflowValidateTimer);
        workflowValidateTimer = setTimeout(() => {
            validateWorkflow($(this).val());
        }, 1500);

        // Debounce — rebuild the LoRA panel 0.5s after the user stops typing
        clearTimeout(loraPanelTimer);
        loraPanelTimer = setTimeout(() => {
            loadLoraPanel();
        }, 500);
    });

    // LoRA Chain — weight edits mutate the runtime graph in place
    $("#comfyinject_lora_rows").on("input", ".comfyinject-lora-weight", function () {
        const row = loraRows[Number($(this).data("row-index"))];
        const entry = getRuntimeWorkflow(loraWorkflowFile);
        if (!row || !entry) return;

        const value = parseFloat($(this).val());
        if (!Number.isFinite(value)) return;

        setLoraWeight(entry.workflow, row.nodeId, value);
        markDirty(loraWorkflowFile);
        updateLoraStatus();
    });

    // LoRA Chain — name edits on appended rows
    $("#comfyinject_lora_rows").on("input", ".comfyinject-lora-name-input", function () {
        const row = loraRows[Number($(this).data("row-index"))];
        const entry = getRuntimeWorkflow(loraWorkflowFile);
        if (!row || !entry) return;

        const value = $(this).val();
        if (!entry.workflow[row.nodeId]?.inputs) return;

        entry.workflow[row.nodeId].inputs.lora_name = value;
        row.name = value;
        markDirty(loraWorkflowFile);
        updateLoraStatus();
    });

    // LoRA Chain — removing a row rewires the graph and re-renders the chain
    $("#comfyinject_lora_rows").on("click", ".comfyinject-lora-remove", function () {
        const row = loraRows[Number($(this).data("row-index"))];
        const entry = getRuntimeWorkflow(loraWorkflowFile);
        if (!row || !entry) return;

        if (!removeLoraNode(entry.workflow, row.nodeId)) return;
        markDirty(loraWorkflowFile);
        renderLoraPanel();
    });

    // LoRA Chain — append a model-only LoRA after the current chain
    $("#comfyinject_lora_add").on("click", function () {
        if (loraLoaderId === null) return;
        const entry = getRuntimeWorkflow(loraWorkflowFile);
        if (!entry) return;

        if (!appendLoraNode(entry.workflow, loraLoaderId, "", 1)) return;
        markDirty(loraWorkflowFile);
        renderLoraPanel();
        $("#comfyinject_lora_rows .comfyinject-lora-name-input").last().trigger("focus");
    });

    // LoRA Chain — discard edits and read the file again
    $("#comfyinject_lora_reload").on("click", async function () {
        const entry = getRuntimeWorkflow(loraWorkflowFile);
        if (entry?.dirty && !confirm(`Discard unsaved LoRA edits for ${loraWorkflowFile}?`)) {
            return;
        }

        try {
            await reloadWorkflow(loraWorkflowFile);
        } catch (err) {
            // loadLoraPanel() reports unreadable files in the status line.
        }
        await loadLoraPanel();
    });

    // LoRA Chain — download the edited workflow JSON
    $("#comfyinject_lora_save").on("click", function () {
        if (loraRows.some((row) => row.appended && row.name.trim() === "")) {
            toastr.warning("Name every added LoRA before saving.", "ComfyInject");
            return;
        }

        const json = serializeWorkflow(loraWorkflowFile);
        if (!json) {
            toastr.warning("Load a workflow before saving.", "ComfyInject");
            return;
        }

        const blob = new Blob([json], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = loraWorkflowFile.split(/[\\/]/).pop() || "workflow.json";
        link.click();
        URL.revokeObjectURL(url);
        toastr.success(`Downloaded ${loraWorkflowFile}. Replace it in workflows/ to persist.`, "ComfyInject");
    });

    // Negative prompt
    $("#comfyinject_negative_prompt").on("input", function () {
        getSettings().negative_prompt = $(this).val();
        saveSettings();
    });

    // Prepend prompt
    $("#comfyinject_prepend_prompt").on("input", function () {
        getSettings().prepend_prompt = $(this).val();
        saveSettings();
    });

    // Append prompt
    $("#comfyinject_append_prompt").on("input", function () {
        getSettings().append_prompt = $(this).val();
        saveSettings();
    });

    // Steps
    $("#comfyinject_steps").on("input", function () {
        getSettings().steps = parseInt($(this).val(), 10);
        saveSettings();
    });

    // CFG
    $("#comfyinject_cfg").on("input", function () {
        getSettings().cfg = parseFloat($(this).val());
        saveSettings();
    });

    // Sampler
    $("#comfyinject_sampler").on("input", function () {
        getSettings().sampler = $(this).val();
        saveSettings();
    });

    // Scheduler
    $("#comfyinject_scheduler").on("input", function () {
        getSettings().scheduler = $(this).val();
        saveSettings();
    });

    // Denoise
    $("#comfyinject_denoise").on("input", function () {
        getSettings().denoise = parseFloat($(this).val());
        saveSettings();
    });

    // Max poll attempts
    $("#comfyinject_max_poll_attempts").on("input", function () {
        getSettings().max_poll_attempts = parseInt($(this).val(), 10);
        saveSettings();
    });

    // Resolution lock — toggle
    $("#comfyinject_resolution_lock_enabled").on("change", function () {
        const locked = $(this).prop("checked");
        getSettings().resolution_lock_enabled = locked;
        updateResolutionLockUI(locked);
        saveSettings();
    });

    // Resolution lock — width
    $("#comfyinject_resolution_lock_width").on("input", function () {
        getSettings().resolution_lock.width = parseInt($(this).val(), 10);
        saveSettings();
    });

    // Resolution lock — height
    $("#comfyinject_resolution_lock_height").on("input", function () {
        getSettings().resolution_lock.height = parseInt($(this).val(), 10);
        saveSettings();
    });

    // Resolutions — width
    $("#comfyinject_resolutions").on("input", ".comfyinject-res-width", function () {
        const token = $(this).data("token");
        getSettings().resolutions[token].width = parseInt($(this).val(), 10);
        saveSettings();
    });

    // Resolutions — height
    $("#comfyinject_resolutions").on("input", ".comfyinject-res-height", function () {
        const token = $(this).data("token");
        getSettings().resolutions[token].height = parseInt($(this).val(), 10);
        saveSettings();
    });

    // Shot lock — toggle
    $("#comfyinject_shot_lock_enabled").on("change", function () {
        const locked = $(this).prop("checked");
        getSettings().shot_lock_enabled = locked;
        updateShotLockUI(locked);
        saveSettings();
    });

    // Shot lock — dropdown
    $("#comfyinject_shot_lock_value").on("change", function () {
        getSettings().shot_lock = $(this).val();
        saveSettings();
    });

    // Shot tags
    $("#comfyinject_shot_tags").on("input", ".comfyinject-shot-tag", function () {
        const token = $(this).data("token");
        getSettings().shot_tags[token] = $(this).val();
        saveSettings();
    });

    // Gallery button
    $("#comfyinject_gallery_btn").on("click", function () {
        openGallery();
    });

    // Advanced settings toggle
    $("#comfyinject_advanced_toggle").on("click", function () {
        $("#comfyinject_advanced_block").toggle();
    });

    // Resolutions toggle
    $("#comfyinject_resolutions_toggle").on("click", function () {
        $("#comfyinject_resolutions_block").toggle();
    });

    // Shot tags toggle
    $("#comfyinject_shot_tags_toggle").on("click", function () {
        $("#comfyinject_shot_tags_block").toggle();
    });

    // Seed lock block toggle
    $("#comfyinject_seed_lock_toggle").on("click", function () {
        $("#comfyinject_seed_lock_block").toggle();
    });


    // Seed lock — toggle
    $("#comfyinject_seed_lock_enabled").on("change", function () {
        const locked = $(this).prop("checked");
        getSettings().seed_lock_enabled = locked;
        updateSeedLockUI(locked);
        saveSettings();
    });

    // Seed lock — mode dropdown
    $("#comfyinject_seed_lock_mode").on("change", function () {
        getSettings().seed_lock_mode = $(this).val();
        // Show/hide the custom seed input based on mode
        $("#comfyinject_seed_lock_custom_input").toggle($(this).val() === "CUSTOM");
        saveSettings();
    });

    // Seed lock — custom value
    $("#comfyinject_seed_lock_value").on("input", function () {
        getSettings().seed_lock_value = parseInt($(this).val(), 10);
        saveSettings();
    });

    // Marker repair notifications
    $("#comfyinject_repair_toast_mode").on("change", function () {
        getSettings().repair_toast_mode = $(this).val();
        saveSettings();
    });

    // AI prompt rewrite — block toggle
    $("#comfyinject_rewrite_toggle").on("click", function () {
        $("#comfyinject_rewrite_block").toggle();
    });

    $("#comfyinject_rewrite_auto_read_preset").on("change", function () {
        getSettings().rewrite_auto_read_preset = $(this).prop("checked");
        saveSettings();
    });

    $("#comfyinject_rewrite_rules_override").on("input", function () {
        getSettings().rewrite_rules_override = $(this).val();
        saveSettings();
    });

    $("#comfyinject_rewrite_context_chars").on("input", function () {
        getSettings().rewrite_context_chars = parseInt($(this).val(), 10) || 0;
        saveSettings();
    });

    $("#comfyinject_rewrite_max_tokens").on("input", function () {
        getSettings().rewrite_max_tokens = parseInt($(this).val(), 10) || 0;
        saveSettings();
    });

    $("#comfyinject_rewrite_timeout_ms").on("input", function () {
        getSettings().rewrite_timeout_ms = parseInt($(this).val(), 10) || 0;
        saveSettings();
    });

    $("#comfyinject_rewrite_debug").on("click", async function () {
        const { text, source } = await resolveRulesText();
        console.log("[ComfyInject] Rewrite rules source:", source);
        console.log(text);
        toastr.info(`Rules source: ${source} (${text.length} characters) — see the console.`, "ComfyInject");
    });

    // Reset button — resets everything except comfy_host, checkpoint, and workflow
    $("#comfyinject_reset").on("click", function () {
        const settings = getSettings();
        const { comfy_host, checkpoint, workflow } = settings;

        // Reset to defaults
        Object.assign(settings, structuredClone(defaultSettings));

        // Restore connection settings
        settings.comfy_host = comfy_host;
        settings.checkpoint = checkpoint;
        settings.workflow = workflow;

        saveSettings();
        populateUI();

        toastr.success("Advanced settings reset to defaults!", "ComfyInject");
    });
}

/**
 * Loads the settings HTML and initializes the UI.
 * Called once from index.js on load.
 */
export async function initUI() {
    const settingsHtml = await $.get(`/${EXTENSION_FOLDER}/settings.html`);
    $("#extensions_settings").append(settingsHtml);
    populateUI();
    wireEvents();

    // Silently try to populate the checkpoint list on load — no toast if ComfyUI isn't running
    refreshCheckpointList(false);

    // Load the LoRA panel and its filename suggestions in the background
    fetchLoraNames();
    loadLoraPanel();
}