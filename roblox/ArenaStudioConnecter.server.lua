--!strict
--[[
    Arena Studio Connecter - Roblox Studio Plugin

    Dieses Plugin wird von der Windows-App automatisch installiert und verbindet
    sich selbst. URL und Session-Token werden ausschließlich über einen separaten,
    nur lokal erreichbaren Discovery-Port geladen und niemals gespeichert.

    WICHTIG: Roblox erlaubt Plugins aus Sicherheitsgründen nicht, die
    HTTP-Freigabe einer Place selbst umzuschalten (diese Einstellung ist
    geschützt). Das Plugin darf diese Einstellung deshalb weder lesen
    noch schreiben - schon der Zugriff darauf lässt die Verbindung scheitern,
    bevor überhaupt eine Anfrage gesendet wurde. Stattdessen stellt das Plugin
    die lokale Anfrage direkt und meldet einen eventuellen Freigabe-Hinweis von
    Roblox sichtbar im Status-Widget. Sobald die Freigabe vorliegt, verbindet
    sich die Place automatisch neu.
]]

local HttpService = game:GetService("HttpService")
local Selection = game:GetService("Selection")
local RunService = game:GetService("RunService")
local LogService = game:GetService("LogService")
local ScriptEditorService = game:GetService("ScriptEditorService")
local StudioService = game:GetService("StudioService")
local Players = game:GetService("Players")
local UserService = game:GetService("UserService")
local MarketplaceService = game:GetService("MarketplaceService")
local InsertService = game:GetService("InsertService")
local StudioTestService = game:GetService("StudioTestService")
local ServerScriptService = game:GetService("ServerScriptService")
local ChangeHistoryService = game:GetService("ChangeHistoryService")

local PLUGIN_NAME = "Arena Studio Connecter"
local PLUGIN_VERSION = "2.1.0"
local DISCOVERY_URL = "http://127.0.0.1:32192/v1/session"
local POLL_IDLE_WAIT = 0.25
local RECONNECT_WAIT = 2.5
local HANDSHAKE_INTERVAL = 10

local state = {
    url = "",
    token = "",
    sessionId = "",
    connected = false,
    running = true,
    loopRunning = false,
    clientId = HttpService:GenerateGUID(false),
    lastError = nil :: string?,
    lastProblemKey = "",
    commandsHandled = 0,
    lastHandshakeAt = 0,
    playtestStarting = false,
    playtestMode = nil :: string?,
    playtestError = nil :: string?,
}

-- Studio kann lokale Plugins zusätzlich im Playtest-Datenmodell laden. Diese
-- zweite Instanz ist keine weitere Place. Der separate, temporäre Server-
-- Reporter übernimmt dort ausschließlich den sicheren Stop-Rückkanal.
if RunService:IsStudio() and RunService:IsRunning() then
    print(string.format("[%s] Playtest-Datenmodell erkannt - keine doppelte Place-Registrierung.", PLUGIN_NAME))
    return
end

local outputBuffer: { { level: string, message: string, at: number } } = {}
local MAX_OUTPUT = 200

LogService.MessageOut:Connect(function(message, messageType)
    local level = "info"
    if messageType == Enum.MessageType.MessageWarning then
        level = "warn"
    elseif messageType == Enum.MessageType.MessageError then
        level = "error"
    end
    table.insert(outputBuffer, { level = level, message = message, at = os.time() })
    if #outputBuffer > MAX_OUTPUT then
        table.remove(outputBuffer, 1)
    end
end)

local function decodeResponse(response: any): (boolean, any)
    if not response.Success then
        return false, string.format("HTTP %d: %s", response.StatusCode, tostring(response.Body))
    end
    local decoded
    local decodeOk = pcall(function()
        decoded = HttpService:JSONDecode(response.Body)
    end)
    if not decodeOk then
        return false, "Antwort konnte nicht gelesen werden"
    end
    return true, decoded
end

--[[
    Verbindungsprobleme verständlich beschreiben.

    Die Abfrage erfolgt ausschließlich anhand der Fehlermeldung der echten
    HTTP-Anfrage. Die geschützte Place-Einstellung für HTTP Requests wird vom
    Plugin bewusst nie berührt: Sie hat LocalUserSecurity, schon der Lesezugriff
    kann für ein Plugin fehlschlagen und ein Schreibzugriff ist immer verboten.
    Genau dieser Zugriff hat in Version 2.0.0 jede Verbindung verhindert.
]]
local function describeConnectionProblem(detail: any): any
    local text = string.lower(tostring(detail or ""))

    -- Eine abgelehnte Bridge-Session (z. B. nach einem Token-Wechsel) heilt
    -- sich selbst, weil die Session danach neu geladen wird.
    if string.find(text, "http 401", 1, true) or string.find(text, "http 403", 1, true) or string.find(text, "http 429", 1, true) then
        return {
            key = "session-abgelehnt",
            actionRequired = false,
            message = "Die Bridge hat die Session abgelehnt.\nEine neue Session wird automatisch geladen ...",
        }
    end

    if string.find(text, "http requests are not enabled", 1, true)
        or string.find(text, "enable via game settings", 1, true)
        or string.find(text, "requests are not enabled", 1, true) then
        return {
            key = "http-aus",
            actionRequired = true,
            message = "HTTP Requests sind fuer diese Place aus.\nEinmalig einschalten: Datei > Experience Settings > Security > Allow HTTP Requests.\nDanach verbindet sich die Place automatisch.",
        }
    end

    if string.find(text, "permission", 1, true)
        or string.find(text, "access denied", 1, true)
        or string.find(text, "not allowed to access", 1, true) then
        return {
            key = "http-berechtigung",
            actionRequired = true,
            message = "Studio hat den HTTP-Zugriff des Plugins abgelehnt.\nErlaube in der Anfrage bzw. unter Plugins > Manage Plugins den Zugriff auf 127.0.0.1.\nDanach verbindet sich die Place automatisch.",
        }
    end

    return {
        key = "app-nicht-erreichbar",
        actionRequired = false,
        message = "Die Connecter-App wurde noch nicht gefunden.\nStarte die Arena Studio Connecter EXE - die Place erscheint dann automatisch.",
    }
end

local function discoverSession(): (boolean, any)
    -- Direkt anfragen: Die lokale Verbindung braucht keine Vorprüfung einer
    -- geschützten Eigenschaft. Ein eventueller Freigabe-Hinweis von Roblox
    -- kommt als Fehler dieser Anfrage zurück und wird oben verständlich erklärt.
    local ok, response = pcall(function()
        return HttpService:RequestAsync({
            Url = DISCOVERY_URL,
            Method = "GET",
            Headers = { ["Accept"] = "application/json" },
        })
    end)
    if not ok then
        return false, tostring(response)
    end

    local decodedOk, session = decodeResponse(response)
    if not decodedOk then
        return false, session
    end
    if typeof(session) ~= "table" or session.ok ~= true then
        local reason = typeof(session) == "table" and session.error or nil
        return false, "Plugin-Erkennung abgelehnt: " .. tostring(reason or "unbekannte Antwort")
    end
    if typeof(session.url) ~= "string" or session.url == "" or typeof(session.token) ~= "string" or session.token == "" then
        return false, "Plugin-Erkennung lieferte eine unvollständige Session"
    end
    return true, session
end

local function request(method: string, requestPath: string, body: any?): (boolean, any)
    if state.url == "" or state.token == "" then
        return false, "Bridge-Session ist noch nicht verfuegbar"
    end

    local options = {
        Url = state.url .. requestPath,
        Method = method,
        Headers = {
            ["Content-Type"] = "application/json",
            ["Authorization"] = "Bearer " .. state.token,
            ["X-Client-Id"] = state.clientId,
            ["X-Client-Name"] = "Roblox Studio",
        },
    }
    if body ~= nil then
        options.Body = HttpService:JSONEncode(body)
    end

    local ok, response = pcall(function()
        return HttpService:RequestAsync(options)
    end)
    if not ok then
        return false, tostring(response)
    end
    if response.StatusCode == 401 or response.StatusCode == 403 then
        state.token = ""
        state.sessionId = ""
    end
    return decodeResponse(response)
end

local accountCache: any = nil
local function readAccount(): any
    if accountCache then
        return accountCache
    end

    local userId = 0
    pcall(function()
        userId = StudioService:GetUserId()
    end)

    local username = nil
    local displayName = nil
    if userId > 0 then
        pcall(function()
            username = Players:GetNameFromUserIdAsync(userId)
        end)
        pcall(function()
            local infos = UserService:GetUserInfosByUserIdsAsync({ userId })
            if infos and infos[1] then
                username = infos[1].Username or username
                displayName = infos[1].DisplayName
            end
        end)
    end

    accountCache = {
        userId = userId,
        username = username,
        displayName = displayName,
    }
    return accountCache
end

local placeNameCache: { name: string, loadedAt: number, published: boolean }? = nil
local function readPlaceName(): string
    local fallback = tostring(game.Name)
    if game.PlaceId <= 0 then
        return fallback
    end
    local now = os.clock()
    if placeNameCache and now - placeNameCache.loadedAt < (placeNameCache.published and 21600 or 60) then
        return placeNameCache.name
    end

    local publishedName = nil
    pcall(function()
        local info = MarketplaceService:GetProductInfoAsync(game.PlaceId, Enum.InfoType.Asset)
        if info and typeof(info.Name) == "string" and info.Name ~= "" then
            publishedName = info.Name
        end
    end)
    -- Kompatibilität mit älteren Studio-Versionen.
    if not publishedName then
        pcall(function()
            local info = MarketplaceService:GetProductInfo(game.PlaceId, Enum.InfoType.Asset)
            if info and typeof(info.Name) == "string" and info.Name ~= "" then
                publishedName = info.Name
            end
        end)
    end
    local cache = {
        name = publishedName or fallback,
        loadedAt = now,
        published = publishedName ~= nil,
    }
    placeNameCache = cache
    return cache.name
end

local function readPlayState(): any
    local editModeActive = true
    local studioTestAvailable = pcall(function()
        editModeActive = StudioTestService.EditModeActive
    end)
    local running = RunService:IsRunning()
    local active = state.playtestStarting or running or (studioTestAvailable and not editModeActive)
    return {
        playtestActive = active,
        starting = state.playtestStarting and editModeActive,
        mode = state.playtestMode or (running and "simulation" or nil),
        isRunning = running,
        isEdit = RunService:IsEdit(),
        editModeActive = editModeActive,
        studioTestAvailable = studioTestAvailable,
        error = state.playtestError,
    }
end

-- ===========================================================================
-- Instance path helpers
-- ===========================================================================

local function resolvePath(path: string): Instance?
	if path == nil or path == "" then
		return nil
	end
	local current: Instance = game
	local segments = string.split(path, ".")
	for index, segment in ipairs(segments) do
		if index == 1 and (segment == "game" or segment == "Game") then
			continue
		end
		local nextInstance = current:FindFirstChild(segment)
		if not nextInstance then
			local serviceOk, service = pcall(function()
				return game:GetService(segment :: any)
			end)
			if serviceOk and service then
				nextInstance = service
			end
		end
		if not nextInstance then
			return nil
		end
		current = nextInstance
	end
	return current
end

local function fullName(instance: Instance): string
	return instance:GetFullName()
end

local function describeInstance(instance: Instance, depth: number): any
	local node = {
		name = instance.Name,
		className = instance.ClassName,
		path = fullName(instance),
		childCount = #instance:GetChildren(),
	}
	if depth > 0 then
		local children = {}
		for _, child in ipairs(instance:GetChildren()) do
			table.insert(children, describeInstance(child, depth - 1))
		end
		node.children = children
	end
	return node
end

local function serializeValue(value: any): any
	local valueType = typeof(value)
	if valueType == "Instance" then
		return { __type = "Instance", path = fullName(value), className = value.ClassName }
	elseif valueType == "EnumItem" then
		return { __type = "EnumItem", enum = tostring(value.EnumType), name = value.Name, value = value.Value }
	elseif valueType == "Vector3" then
		return { __type = "Vector3", x = value.X, y = value.Y, z = value.Z }
	elseif valueType == "Vector2" then
		return { __type = "Vector2", x = value.X, y = value.Y }
	elseif valueType == "CFrame" then
		return { __type = "CFrame", components = { value:GetComponents() } }
	elseif valueType == "Color3" then
		return { __type = "Color3", r = value.R, g = value.G, b = value.B }
	elseif valueType == "UDim2" then
		return { __type = "UDim2", xScale = value.X.Scale, xOffset = value.X.Offset, yScale = value.Y.Scale, yOffset = value.Y.Offset }
	elseif valueType == "BrickColor" then
		return { __type = "BrickColor", name = value.Name }
	elseif valueType == "string" or valueType == "number" or valueType == "boolean" then
		return value
	elseif value == nil then
		return nil
	end
	return tostring(value)
end

local function coerceValue(raw: any): any
	if typeof(raw) ~= "table" then
		return raw
	end
	if raw.__type == "Vector3" then
		return Vector3.new(raw.x or 0, raw.y or 0, raw.z or 0)
	elseif raw.__type == "Color3" then
		return Color3.new(raw.r or 0, raw.g or 0, raw.b or 0)
	elseif raw.__type == "UDim2" then
		return UDim2.new(raw.xScale or 0, raw.xOffset or 0, raw.yScale or 0, raw.yOffset or 0)
	elseif raw.__type == "BrickColor" then
		return BrickColor.new(raw.name)
	elseif raw.__type == "EnumItem" then
		local enumType = (Enum :: any)[raw.enum:gsub("^Enum%.", "")]
		if enumType then
			return enumType[raw.name]
		end
	elseif raw.__type == "Instance" then
		return resolvePath(raw.path)
	end
	return raw
end

-- ===========================================================================
-- Temporary playtest server reporter
-- ===========================================================================

local function buildPlaytestReporterSource(): string
    local replacements: { [string]: string } = {
        ARENA_URL = HttpService:JSONEncode(state.url),
        ARENA_TOKEN = HttpService:JSONEncode(state.token),
        ARENA_CLIENT = HttpService:JSONEncode(state.clientId .. ":play-server"),
        ARENA_EDIT_CLIENT = HttpService:JSONEncode(state.clientId),
        ARENA_VERSION = HttpService:JSONEncode(PLUGIN_VERSION),
        ARENA_PLACE_NAME = HttpService:JSONEncode(readPlaceName()),
        ARENA_MODE = HttpService:JSONEncode(state.playtestMode or "play"),
    }
    local source = [==[
local HttpService = game:GetService("HttpService")
local RunService = game:GetService("RunService")
local StudioTestService = game:GetService("StudioTestService")
if not RunService:IsStudio() or not RunService:IsServer() or not RunService:IsRunning() then
    return
end

local bridgeUrl = __ARENA_URL__
local bridgeToken = __ARENA_TOKEN__
local clientId = __ARENA_CLIENT__
local editClientId = __ARENA_EDIT_CLIENT__
local pluginVersion = __ARENA_VERSION__
local placeName = __ARENA_PLACE_NAME__
local playtestMode = __ARENA_MODE__

local function decode(response)
    if not response.Success then
        return false, "HTTP " .. tostring(response.StatusCode) .. ": " .. tostring(response.Body)
    end
    local ok, body = pcall(function()
        return HttpService:JSONDecode(response.Body)
    end)
    return ok, body
end

local function rediscover()
    local ok, response = pcall(function()
        return HttpService:RequestAsync({ Url = "http://127.0.0.1:32192/v1/session", Method = "GET" })
    end)
    if not ok then return false end
    local decoded, session = decode(response)
    if decoded and session and session.ok then
        bridgeUrl = session.url
        bridgeToken = session.token
        return true
    end
    return false
end

local function request(method, requestPath, body)
    for attempt = 1, 2 do
        local options = {
            Url = bridgeUrl .. requestPath,
            Method = method,
            Headers = {
                ["Content-Type"] = "application/json",
                ["Authorization"] = "Bearer " .. bridgeToken,
                ["X-Client-Id"] = clientId,
                ["X-Client-Name"] = "Arena Playtest Server",
            },
        }
        if body ~= nil then options.Body = HttpService:JSONEncode(body) end
        local ok, response = pcall(function()
            return HttpService:RequestAsync(options)
        end)
        if ok then
            if (response.StatusCode == 401 or response.StatusCode == 403) and attempt == 1 then
                rediscover()
            else
                return decode(response)
            end
        else
            return false, tostring(response)
        end
    end
    return false, "Keine gueltige Bridge-Session"
end

local function handshake()
    return request("POST", "/studio/handshake", {
        clientId = clientId,
        name = "Roblox Studio Playtest Server",
        version = pluginVersion,
        place = tostring(game.PlaceId),
        placeId = game.PlaceId,
        placeName = placeName,
        gameId = game.GameId,
        placeVersion = game.PlaceVersion,
        isEdit = false,
        isRunning = true,
        dataModelRole = "play-server",
        editClientId = editClientId,
        playtestActive = true,
        playtestMode = playtestMode,
    })
end

handshake()
while true do
    local ok, response = request("GET", "/studio/poll")
    if not ok then
        task.wait(2)
        handshake()
    elseif response.command then
        local command = response.command
        if command.action == "stop_game" then
            local stopped, stopError = pcall(function()
                StudioTestService:EndTest("Arena AI Stop")
            end)
            request("POST", "/studio/result", {
                id = command.id,
                ok = stopped,
                result = stopped and { stopped = true, playtestActive = false, message = "Playtest wird beendet" } or nil,
                error = stopped and nil or tostring(stopError),
            })
            if stopped then return end
        elseif command.action == "get_play_state" or command.action == "ping" then
            request("POST", "/studio/result", {
                id = command.id,
                ok = true,
                result = { pong = command.action == "ping", playtestActive = true, isRunning = true, isEdit = false, dataModelRole = "play-server" },
            })
        else
            request("POST", "/studio/result", {
                id = command.id,
                ok = false,
                error = "Der Playtest-Reporter akzeptiert nur Status und Stop.",
            })
        end
    else
        task.wait(0.2)
    end
end
]==]
    for key, value in pairs(replacements) do
        source = source:gsub("__" .. key .. "__", function()
            return value
        end)
    end
    return source
end

local function createPlaytestReporter(): Script
    local reporter = Instance.new("Script")
    reporter.Name = "__ArenaPlaytestReporter"
    reporter.Source = buildPlaytestReporterSource()
    reporter.Parent = ServerScriptService
    return reporter
end

-- ===========================================================================
-- Command handlers
-- ===========================================================================

local handlers: { [string]: (params: any) -> any } = {}

handlers.ping = function()
	return {
		pong = true,
		studio = true,
		version = PLUGIN_VERSION,
		placeId = game.PlaceId,
		isRunning = RunService:IsRunning(),
	}
end

handlers.get_place_info = function()
	return {
		placeId = game.PlaceId,
		gameId = game.GameId,
		name = readPlaceName(),
		creatorId = game.CreatorId,
		creatorType = tostring(game.CreatorType),
		placeVersion = game.PlaceVersion,
		workspaceChildren = #workspace:GetChildren(),
		isRunning = RunService:IsRunning(),
		isEdit = RunService:IsEdit(),
		studioVersion = version(),
	}
end

handlers.get_play_state = function()
    return readPlayState()
end

handlers.play_game = function(params)
    local mode = string.lower(tostring(params.mode or "play"))
    if mode ~= "play" and mode ~= "run" then
        error("Parameter 'mode' muss 'play' oder 'run' sein", 0)
    end
    local playState = readPlayState()
    if playState.playtestActive then
        error("In Studio läuft bereits ein Playtest", 0)
    end

    if not playState.studioTestAvailable then
        -- Ältere Studio-Versionen: Simulation im selben Datenmodell.
        state.playtestMode = "simulation"
        RunService:Run()
        return { started = true, mode = "simulation", legacy = true, state = readPlayState() }
    end

    state.playtestStarting = true
    state.playtestMode = mode
    state.playtestError = nil
    local reporter = createPlaytestReporter()
    pcall(function()
        ChangeHistoryService:SetWaypoint("Arena Playtest starten")
    end)

    task.spawn(function()
        task.wait(0.2)
        local ok, result = pcall(function()
            local args = { source = "Arena Studio Connecter", mode = mode }
            if mode == "run" then
                return StudioTestService:ExecuteRunModeAsync(args)
            end
            return StudioTestService:ExecutePlayModeAsync(args)
        end)
        reporter:Destroy()
        state.playtestStarting = false
        state.playtestMode = nil
        if ok then
            state.playtestError = nil
        else
            state.playtestError = tostring(result)
        end
    end)

    return { started = true, accepted = true, mode = mode, legacy = false, state = readPlayState() }
end

handlers.stop_game = function()
    -- Bei echten Playtests leitet die Bridge diesen Befehl an den temporären
    -- Server-Reporter weiter. RunService:Stop ist nur fuer die alte Simulation
    -- im selben Datenmodell vorgesehen.
    if RunService:IsRunning() then
        RunService:Stop()
        state.playtestMode = nil
        return { stopped = true, mode = "simulation", state = readPlayState() }
    end
    if readPlayState().playtestActive then
        error("Der Playtest-Server ist noch nicht bereit. Bitte kurz erneut versuchen.", 0)
    end
    return { stopped = false, alreadyStopped = true, mode = state.playtestMode or "none", state = readPlayState() }
end

handlers.run_luau = function(params)
	local code = params.code
	if typeof(code) ~= "string" or code == "" then
		error("Parameter 'code' (string) wird benoetigt", 0)
	end

	local chunk, compileError = loadstring(code)
	if not chunk then
		error("Kompilierfehler: " .. tostring(compileError), 0)
	end

	local captured = {}
	local startedAt = os.clock()
	local connection = LogService.MessageOut:Connect(function(message)
		table.insert(captured, message)
	end)

	local ok, result = pcall(chunk)
	connection:Disconnect()

	if not ok then
		error("Laufzeitfehler: " .. tostring(result), 0)
	end

	return {
		returned = serializeValue(result),
		output = captured,
		durationMs = math.floor((os.clock() - startedAt) * 1000),
	}
end

handlers.list_instances = function(params)
	local instance = resolvePath(params.path or "game")
	if not instance then
		error("Pfad nicht gefunden: " .. tostring(params.path), 0)
	end
	local depth = math.clamp(tonumber(params.depth) or 1, 0, 5)
	return describeInstance(instance, depth)
end

handlers.get_instance = function(params)
	local instance = resolvePath(params.path)
	if not instance then
		error("Pfad nicht gefunden: " .. tostring(params.path), 0)
	end

	local properties = {}
	for _, propertyName in ipairs({
		"Name", "ClassName", "Parent", "Archivable", "Anchored", "CanCollide", "Transparency",
		"Size", "Position", "Color", "Material", "Visible", "Enabled", "Text", "Value", "Disabled",
	}) do
		local ok, value = pcall(function()
			return (instance :: any)[propertyName]
		end)
		if ok and value ~= nil then
			properties[propertyName] = serializeValue(value)
		end
	end

	return {
		path = fullName(instance),
		className = instance.ClassName,
		properties = properties,
		childCount = #instance:GetChildren(),
	}
end

handlers.create_instance = function(params)
	local className = params.className
	if typeof(className) ~= "string" then
		error("Parameter 'className' wird benoetigt", 0)
	end
	local parent = resolvePath(params.parent or "game.Workspace")
	if not parent then
		error("Parent nicht gefunden: " .. tostring(params.parent), 0)
	end

	local ok, instance = pcall(function()
		return Instance.new(className :: any)
	end)
	if not ok then
		error("Unbekannte Klasse: " .. className, 0)
	end

	if typeof(params.properties) == "table" then
		for key, value in pairs(params.properties) do
			local setOk, setErr = pcall(function()
				(instance :: any)[key] = coerceValue(value)
			end)
			if not setOk then
				warn(string.format("[%s] Property '%s' konnte nicht gesetzt werden: %s", PLUGIN_NAME, key, tostring(setErr)))
			end
		end
	end

	instance.Parent = parent
	return { created = true, path = fullName(instance), className = instance.ClassName }
end

handlers.insert_model = function(params)
    local rawAssetId = tostring(params.assetId or "")
    local assetIdText = rawAssetId:match("^(%d+)$")
        or rawAssetId:match("^rbxassetid://(%d+)$")
        or rawAssetId:match("roblox%.com/library/(%d+)")
    local assetId = tonumber(assetIdText)
    if not assetId or assetId <= 0 then
        error("Parameter 'assetId' muss eine positive Roblox-Asset-ID sein", 0)
    end
    local parent = resolvePath(params.parent or "game.Workspace")
    if not parent then
        error("Parent nicht gefunden: " .. tostring(params.parent), 0)
    end

    local ok, loaded = pcall(function()
        return InsertService:LoadAsset(assetId)
    end)
    if not ok then
        error("Modell konnte nicht geladen werden (eventuell noch in Moderation): " .. tostring(loaded), 0)
    end
    local roots = typeof(loaded) == "Instance" and { loaded } or loaded
    if typeof(roots) ~= "table" or #roots == 0 then
        error("Open Cloud hat kein einfuegbares Modell geliefert", 0)
    end

    local inserted = {}
    local paths = {}
    for _, instance in ipairs(roots) do
        if typeof(params.name) == "string" and params.name ~= "" and #roots == 1 then
            instance.Name = params.name
        end
        instance.Parent = parent
        if params.position ~= nil then
            local position = coerceValue(params.position)
            if typeof(position) ~= "Vector3" then
                error("position muss ein Vector3 sein", 0)
            end
            instance:PivotTo(CFrame.new(position))
        end
        table.insert(inserted, instance)
        table.insert(paths, fullName(instance))
    end
    Selection:Set(inserted)
    return { inserted = true, assetId = assetId, count = #inserted, paths = paths }
end

handlers.set_property = function(params)
	local instance = resolvePath(params.path)
	if not instance then
		error("Pfad nicht gefunden: " .. tostring(params.path), 0)
	end
	local ok, err = pcall(function()
		(instance :: any)[params.property] = coerceValue(params.value)
	end)
	if not ok then
		error(string.format("Property '%s' konnte nicht gesetzt werden: %s", tostring(params.property), tostring(err)), 0)
	end
	return { updated = true, path = fullName(instance), property = params.property }
end

handlers.delete_instance = function(params)
	local instance = resolvePath(params.path)
	if not instance then
		error("Pfad nicht gefunden: " .. tostring(params.path), 0)
	end
	local path = fullName(instance)
	instance:Destroy()
	return { deleted = true, path = path }
end

handlers.get_script_source = function(params)
	local instance = resolvePath(params.path)
	if not instance or not instance:IsA("LuaSourceContainer") then
		error("Kein Script gefunden unter: " .. tostring(params.path), 0)
	end
	local ok, source = pcall(function()
		return ScriptEditorService:GetEditorSource(instance)
	end)
	if not ok then
		source = (instance :: any).Source
	end
	return { path = fullName(instance), className = instance.ClassName, source = source }
end

handlers.set_script_source = function(params)
	local instance = resolvePath(params.path)
	if not instance or not instance:IsA("LuaSourceContainer") then
		error("Kein Script gefunden unter: " .. tostring(params.path), 0)
	end
	if typeof(params.source) ~= "string" then
		error("Parameter 'source' (string) wird benoetigt", 0)
	end

	local ok, err = pcall(function()
		ScriptEditorService:UpdateSourceAsync(instance, function()
			return params.source
		end)
	end)
	if not ok then
		local fallbackOk, fallbackErr = pcall(function()
			(instance :: any).Source = params.source
		end)
		if not fallbackOk then
			error("Source konnte nicht gesetzt werden: " .. tostring(err) .. " / " .. tostring(fallbackErr), 0)
		end
	end
	return { updated = true, path = fullName(instance), length = #params.source }
end

handlers.get_selection = function()
	local items = {}
	for _, instance in ipairs(Selection:Get()) do
		table.insert(items, { path = fullName(instance), className = instance.ClassName, name = instance.Name })
	end
	return { count = #items, selection = items }
end

handlers.set_selection = function(params)
	local instances = {}
	local missing = {}
	for _, path in ipairs(params.paths or {}) do
		local instance = resolvePath(path)
		if instance then
			table.insert(instances, instance)
		else
			table.insert(missing, path)
		end
	end
	Selection:Set(instances)
	return { selected = #instances, missing = missing }
end

handlers.get_output = function(params)
	local limit = math.clamp(tonumber(params.limit) or 50, 1, MAX_OUTPUT)
	local entries = {}
	local startIndex = math.max(1, #outputBuffer - limit + 1)
	for index = startIndex, #outputBuffer do
		table.insert(entries, outputBuffer[index])
	end
	return { count = #entries, entries = entries }
end

-- ===========================================================================
-- Status UI (no URL or token fields by design)
-- ===========================================================================

local toolbar = plugin:CreateToolbar(PLUGIN_NAME)
local toggleButton = toolbar:CreateButton(
    "Arena Studio Connecter",
    "Status der automatischen Arena-Verbindung anzeigen",
    "rbxasset://textures/ui/GuiImagePlaceholder.png"
)

local widgetInfo = DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Float, false, false, 390, 285, 340, 240)
local widget = plugin:CreateDockWidgetPluginGui("ArenaStudioConnecterWidget", widgetInfo)
widget.Title = "Arena Studio Connecter"

local root = Instance.new("Frame")
root.Size = UDim2.fromScale(1, 1)
root.BackgroundColor3 = Color3.fromRGB(8, 15, 32)
root.BorderSizePixel = 0
root.Parent = widget

local accent = Instance.new("Frame")
accent.Size = UDim2.new(1, 0, 0, 3)
accent.BackgroundColor3 = Color3.fromRGB(104, 83, 235)
accent.BorderSizePixel = 0
accent.Parent = root

local title = Instance.new("TextLabel")
title.Position = UDim2.fromOffset(18, 18)
title.Size = UDim2.new(1, -36, 0, 24)
title.BackgroundTransparency = 1
title.Text = "Arena Studio Connecter"
title.TextColor3 = Color3.fromRGB(238, 243, 255)
title.TextXAlignment = Enum.TextXAlignment.Left
title.Font = Enum.Font.GothamBold
title.TextSize = 17
title.Parent = root

local subtitle = Instance.new("TextLabel")
subtitle.Position = UDim2.fromOffset(18, 43)
subtitle.Size = UDim2.new(1, -36, 0, 18)
subtitle.BackgroundTransparency = 1
subtitle.Text = "Automatische Verbindung - keine Zugangsdaten noetig"
subtitle.TextColor3 = Color3.fromRGB(104, 119, 151)
subtitle.TextXAlignment = Enum.TextXAlignment.Left
subtitle.Font = Enum.Font.Gotham
subtitle.TextSize = 10
subtitle.Parent = root

local statusCard = Instance.new("Frame")
statusCard.Position = UDim2.fromOffset(18, 76)
statusCard.Size = UDim2.new(1, -36, 0, 112)
statusCard.BackgroundColor3 = Color3.fromRGB(13, 24, 49)
statusCard.BorderSizePixel = 0
statusCard.Parent = root
local statusCorner = Instance.new("UICorner")
statusCorner.CornerRadius = UDim.new(0, 10)
statusCorner.Parent = statusCard
local statusStroke = Instance.new("UIStroke")
statusStroke.Color = Color3.fromRGB(37, 58, 99)
statusStroke.Transparency = 0.35
statusStroke.Parent = statusCard

local statusDot = Instance.new("Frame")
statusDot.Position = UDim2.fromOffset(14, 16)
statusDot.Size = UDim2.fromOffset(10, 10)
statusDot.BackgroundColor3 = Color3.fromRGB(251, 191, 92)
statusDot.BorderSizePixel = 0
statusDot.Parent = statusCard
local dotCorner = Instance.new("UICorner")
dotCorner.CornerRadius = UDim.new(1, 0)
dotCorner.Parent = statusDot

local statusLabel = Instance.new("TextLabel")
statusLabel.Position = UDim2.fromOffset(34, 10)
statusLabel.Size = UDim2.new(1, -47, 0, 90)
statusLabel.BackgroundTransparency = 1
statusLabel.Text = "Suche die Arena Studio Connecter App ..."
statusLabel.TextColor3 = Color3.fromRGB(170, 184, 214)
statusLabel.TextXAlignment = Enum.TextXAlignment.Left
statusLabel.TextYAlignment = Enum.TextYAlignment.Top
statusLabel.TextWrapped = true
statusLabel.Font = Enum.Font.Gotham
statusLabel.TextSize = 11
statusLabel.Parent = statusCard

local retryButton = Instance.new("TextButton")
retryButton.Position = UDim2.new(0, 18, 1, -56)
retryButton.Size = UDim2.new(1, -36, 0, 34)
retryButton.BackgroundColor3 = Color3.fromRGB(75, 68, 180)
retryButton.BorderSizePixel = 0
retryButton.Text = "Jetzt erneut verbinden"
retryButton.TextColor3 = Color3.fromRGB(245, 247, 255)
retryButton.Font = Enum.Font.GothamBold
retryButton.TextSize = 11
retryButton.Parent = root
local retryCorner = Instance.new("UICorner")
retryCorner.CornerRadius = UDim.new(0, 8)
retryCorner.Parent = retryButton

local COLOR_OK = Color3.fromRGB(53, 213, 154)
local COLOR_ERR = Color3.fromRGB(251, 113, 133)
local COLOR_IDLE = Color3.fromRGB(251, 191, 92)

local function setStatus(message: string, color: Color3)
    statusLabel.Text = message
    statusLabel.TextColor3 = color
    statusDot.BackgroundColor3 = color
end

-- Zeigt ein Verbindungsproblem genau einmal pro neuer Ursache an (Widget +
-- Output), damit weder der Bildschirm noch die Konsole im 2,5-Sekunden-Takt
-- der Wiederverbindungsversuche geflutet wird.
local function reportProblem(problem: any, detail: any)
    state.connected = false
    state.lastError = tostring(detail)
    setStatus(problem.message, COLOR_ERR)

    if problem.key ~= state.lastProblemKey then
        state.lastProblemKey = problem.key
        warn(string.format("[%s] Verbindung wartet (%s): %s", PLUGIN_NAME, tostring(problem.key), tostring(detail)))
        -- Nur wenn der Nutzer wirklich etwas tun muss, das Widget einmalig
        -- öffnen. Eine noch nicht gestartete EXE ist dagegen Normalbetrieb.
        if problem.actionRequired then
            widget.Enabled = true
        end
    end
end

local function clearProblem()
    state.lastProblemKey = ""
    state.lastError = nil
end

-- ===========================================================================
-- Automatic connection loop
-- ===========================================================================

local function handleCommand(command: any)
    local handler = handlers[command.action]
    local payload
    if not handler then
        payload = { id = command.id, ok = false, error = "Unbekannte Aktion: " .. tostring(command.action) }
    else
        local ok, result = pcall(handler, command.params or {})
        if ok then
            payload = { id = command.id, ok = true, result = result }
        else
            payload = { id = command.id, ok = false, error = tostring(result) }
        end
    end

    state.commandsHandled += 1
    local sent, err = request("POST", "/studio/result", payload)
    if not sent then
        warn(string.format("[%s] Ergebnis konnte nicht gesendet werden: %s", PLUGIN_NAME, tostring(err)))
    end
end

local function handshake(): (boolean, any)
    local account = readAccount()
    local playState = readPlayState()
    return request("POST", "/studio/handshake", {
        clientId = state.clientId,
        name = "Roblox Studio",
        version = PLUGIN_VERSION,
        place = tostring(game.PlaceId),
        placeId = game.PlaceId,
        placeName = readPlaceName(),
        gameId = game.GameId,
        placeVersion = game.PlaceVersion,
        studioVersion = version(),
        accountUserId = account.userId,
        accountName = account.username,
        accountDisplayName = account.displayName,
        isEdit = RunService:IsEdit(),
        isRunning = RunService:IsRunning(),
        dataModelRole = "edit",
        playtestActive = playState.playtestActive,
        playtestMode = playState.mode,
    })
end

-- Ein kompletter Verbindungszyklus: Session entdecken, Handshake, danach
-- Befehle pollen, bis die Verbindung abreißt oder das Token verworfen wird.
local function runConnectedSession()
    if state.token == "" then
        state.connected = false
        setStatus("Suche die Connecter App ...\nURL und Token werden automatisch geladen.", COLOR_IDLE)
        local found, session = discoverSession()
        if not found then
            reportProblem(describeConnectionProblem(session), session)
            return
        end
        state.url = tostring(session.url or "")
        state.token = tostring(session.token or "")
        state.sessionId = tostring(session.sessionId or "")
    end

    setStatus("Verbinde automatisch mit der lokalen Bridge ...", COLOR_IDLE)
    local accepted, response = handshake()
    if not accepted then
        state.token = ""
        reportProblem(describeConnectionProblem(response), response)
        return
    end

    state.connected = true
    state.lastHandshakeAt = os.clock()
    clearProblem()
    setStatus(string.format("Verbunden - Place %s\nBefehle verarbeitet: %d", tostring(game.PlaceId), state.commandsHandled), COLOR_OK)

    while state.running and state.token ~= "" do
        if os.clock() - state.lastHandshakeAt >= HANDSHAKE_INTERVAL then
            local refreshed, refreshError = handshake()
            if not refreshed then
                state.token = ""
                reportProblem(describeConnectionProblem(refreshError), refreshError)
                return
            end
            state.lastHandshakeAt = os.clock()
        end
        local ok, pollResponse = request("GET", "/studio/poll")
        if not ok then
            state.token = ""
            reportProblem(describeConnectionProblem(pollResponse), pollResponse)
            return
        end

        if pollResponse.command then
            setStatus(string.format("Arena fuehrt aus: %s", tostring(pollResponse.command.action)), COLOR_OK)
            -- Ein fehlerhafter Befehl darf die Verbindung nicht abreißen lassen.
            local handled, handleError = pcall(handleCommand, pollResponse.command)
            if not handled then
                warn(string.format("[%s] Befehl konnte nicht verarbeitet werden: %s", PLUGIN_NAME, tostring(handleError)))
            end
            setStatus(string.format("Verbunden - Place %s\nBefehle verarbeitet: %d", tostring(game.PlaceId), state.commandsHandled), COLOR_OK)
        else
            task.wait(POLL_IDLE_WAIT)
        end
    end
end

-- Das Herzstück der Reparatur: Jeder Zyklus läuft geschützt. Ein einzelner
-- Fehler (wie früher der verbotene Zugriff auf die HTTP-Einstellung) beendet
-- nur diesen Versuch - die Schleife selbst kann nie mehr lautlos sterben.
-- Dadurch verbindet sich die Place von selbst, sobald die EXE startet oder
-- eine Freigabe nachträglich erteilt wurde, ganz ohne Studio-Neustart.
local function connectionLoop()
    state.loopRunning = true
    while state.running do
        local ok, err = pcall(runConnectedSession)
        if not ok then
            state.token = ""
            state.connected = false
            reportProblem(describeConnectionProblem(err), err)
        end
        if state.running then
            task.wait(RECONNECT_WAIT)
        end
    end
    state.loopRunning = false
    state.connected = false
end

local function ensureConnectionLoop()
    if not state.loopRunning then
        task.spawn(connectionLoop)
    end
end

retryButton.MouseButton1Click:Connect(function()
    state.token = ""
    state.connected = false
    clearProblem()
    setStatus("Manueller Neuaufbau gestartet ...", COLOR_IDLE)
    -- Falls die Schleife je beendet wurde, startet der Button sie wirklich neu.
    ensureConnectionLoop()
end)

toggleButton.Click:Connect(function()
    widget.Enabled = not widget.Enabled
end)

plugin.Unloading:Connect(function()
    state.running = false
end)

ensureConnectionLoop()
print(string.format("[%s] Plugin v%s geladen - automatische Verbindung aktiv.", PLUGIN_NAME, PLUGIN_VERSION))
