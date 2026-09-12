--!strict
--[[
	NexusAI Bridge - Roblox Studio Plugin

	Installation:
	  1. Diese Datei nach %LOCALAPPDATA%\Roblox\Plugins\NexusAIPlugin.server.lua kopieren
	     (oder in Studio: Rechtsklick auf ein Script -> "Save as Local Plugin").
	  2. Studio neu starten -> Toolbar "NexusAI" erscheint.
	  3. Bridge starten (start-bridge.bat), url + token aus der ---BRIDGE--- Box
	     in das Plugin-Fenster eintragen und auf "Verbinden" klicken.

	WICHTIG: Es ist KEIN Token fest hinterlegt. Der Token wird bei jedem Start
	der Bridge neu erzeugt und muss hier eingetragen werden. Die zuletzt
	genutzte URL wird gemerkt, der Token bewusst NICHT dauerhaft gespeichert.

	Voraussetzung in Studio:
	  Game Settings -> Security -> "Allow HTTP Requests" aktivieren.
--]]

local HttpService = game:GetService("HttpService")
local Selection = game:GetService("Selection")
local RunService = game:GetService("RunService")
local LogService = game:GetService("LogService")
local ScriptEditorService = game:GetService("ScriptEditorService")

local PLUGIN_NAME = "NexusAI"
local PLUGIN_VERSION = "1.0.0"
local POLL_IDLE_WAIT = 0.35
local RECONNECT_WAIT = 3

-- ===========================================================================
-- State
-- ===========================================================================

local state = {
	url = plugin:GetSetting("NexusAI_Url") or "http://127.0.0.1:8787",
	token = "", -- niemals persistiert: jede Sitzung hat einen neuen Token
	connected = false,
	running = false,
	clientId = HttpService:GenerateGUID(false),
	lastError = nil :: string?,
	commandsHandled = 0,
}

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

-- ===========================================================================
-- HTTP helpers
-- ===========================================================================

local function request(method: string, path: string, body: any?): (boolean, any)
	if state.url == "" or state.token == "" then
		return false, "url oder token fehlt"
	end

	local options = {
		Url = state.url .. path,
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
	if not response.Success then
		local detail = response.Body
		if response.StatusCode == 403 then
			detail = "Token ungueltig - die Bridge erzeugt bei jedem Start einen neuen Token."
		elseif response.StatusCode == 401 then
			detail = "Token fehlt."
		end
		return false, string.format("HTTP %d: %s", response.StatusCode, tostring(detail))
	end

	local decoded
	local decodeOk = pcall(function()
		decoded = HttpService:JSONDecode(response.Body)
	end)
	if not decodeOk then
		return false, "Antwort konnte nicht dekodiert werden"
	end
	return true, decoded
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
		name = game.Name,
		creatorId = game.CreatorId,
		creatorType = tostring(game.CreatorType),
		placeVersion = game.PlaceVersion,
		workspaceChildren = #workspace:GetChildren(),
		isRunning = RunService:IsRunning(),
		isEdit = RunService:IsEdit(),
		studioVersion = version(),
	}
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
-- UI
-- ===========================================================================

local toolbar = plugin:CreateToolbar(PLUGIN_NAME)
local toggleButton = toolbar:CreateButton("NexusAI Bridge", "Verbindung zur NexusAI Bridge verwalten", "rbxasset://textures/ui/GuiImagePlaceholder.png")

local widgetInfo = DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Float, false, false, 380, 300, 340, 260)
local widget = plugin:CreateDockWidgetPluginGui("NexusAIBridgeWidget", widgetInfo)
widget.Title = "NexusAI Bridge"

local root = Instance.new("Frame")
root.Size = UDim2.fromScale(1, 1)
root.BackgroundColor3 = Color3.fromRGB(24, 26, 33)
root.BorderSizePixel = 0
root.Parent = widget

local layout = Instance.new("UIListLayout")
layout.Padding = UDim.new(0, 8)
layout.SortOrder = Enum.SortOrder.LayoutOrder
layout.Parent = root

local padding = Instance.new("UIPadding")
padding.PaddingTop = UDim.new(0, 12)
padding.PaddingLeft = UDim.new(0, 12)
padding.PaddingRight = UDim.new(0, 12)
padding.PaddingBottom = UDim.new(0, 12)
padding.Parent = root

local function createLabel(text: string, order: number): TextLabel
	local label = Instance.new("TextLabel")
	label.Size = UDim2.new(1, 0, 0, 16)
	label.BackgroundTransparency = 1
	label.Text = text
	label.TextColor3 = Color3.fromRGB(150, 160, 180)
	label.TextXAlignment = Enum.TextXAlignment.Left
	label.Font = Enum.Font.Gotham
	label.TextSize = 12
	label.LayoutOrder = order
	label.Parent = root
	return label
end

local function createInput(placeholder: string, value: string, order: number, masked: boolean): TextBox
	local box = Instance.new("TextBox")
	box.Size = UDim2.new(1, 0, 0, 30)
	box.BackgroundColor3 = Color3.fromRGB(35, 38, 47)
	box.BorderSizePixel = 0
	box.Text = value
	box.PlaceholderText = placeholder
	box.TextColor3 = Color3.fromRGB(235, 240, 250)
	box.PlaceholderColor3 = Color3.fromRGB(110, 118, 135)
	box.Font = Enum.Font.Code
	box.TextSize = 13
	box.ClearTextOnFocus = false
	box.TextXAlignment = Enum.TextXAlignment.Left
	box.LayoutOrder = order
	box.Parent = root

	local boxPadding = Instance.new("UIPadding")
	boxPadding.PaddingLeft = UDim.new(0, 8)
	boxPadding.PaddingRight = UDim.new(0, 8)
	boxPadding.Parent = box

	local corner = Instance.new("UICorner")
	corner.CornerRadius = UDim.new(0, 6)
	corner.Parent = box

	return box
end

createLabel("Bridge URL", 1)
local urlBox = createInput("http://127.0.0.1:8787", state.url, 2, false)

createLabel("Token (aendert sich bei jedem Bridge-Start)", 3)
local tokenBox = createInput("nxs_...", "", 4, true)

local connectButton = Instance.new("TextButton")
connectButton.Size = UDim2.new(1, 0, 0, 34)
connectButton.BackgroundColor3 = Color3.fromRGB(79, 140, 255)
connectButton.BorderSizePixel = 0
connectButton.Text = "Verbinden"
connectButton.TextColor3 = Color3.fromRGB(255, 255, 255)
connectButton.Font = Enum.Font.GothamBold
connectButton.TextSize = 14
connectButton.LayoutOrder = 5
connectButton.Parent = root

local connectCorner = Instance.new("UICorner")
connectCorner.CornerRadius = UDim.new(0, 6)
connectCorner.Parent = connectButton

local statusLabel = Instance.new("TextLabel")
statusLabel.Size = UDim2.new(1, 0, 0, 56)
statusLabel.BackgroundTransparency = 1
statusLabel.Text = "Nicht verbunden.\nBridge starten und url + token eintragen."
statusLabel.TextColor3 = Color3.fromRGB(150, 160, 180)
statusLabel.TextXAlignment = Enum.TextXAlignment.Left
statusLabel.TextYAlignment = Enum.TextYAlignment.Top
statusLabel.TextWrapped = true
statusLabel.Font = Enum.Font.Gotham
statusLabel.TextSize = 12
statusLabel.LayoutOrder = 6
statusLabel.Parent = root

local function setStatus(text: string, color: Color3)
	statusLabel.Text = text
	statusLabel.TextColor3 = color
end

local COLOR_OK = Color3.fromRGB(53, 208, 127)
local COLOR_ERR = Color3.fromRGB(255, 95, 109)
local COLOR_IDLE = Color3.fromRGB(150, 160, 180)

-- ===========================================================================
-- Polling loop
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

local function pollLoop()
	while state.running do
		local ok, response = request("GET", "/studio/poll")

		if not ok then
			state.connected = false
			state.lastError = tostring(response)
			setStatus("Verbindung verloren:\n" .. tostring(response), COLOR_ERR)
			task.wait(RECONNECT_WAIT)
			continue
		end

		if not state.connected then
			state.connected = true
			setStatus(string.format("Verbunden mit %s\nBefehle verarbeitet: %d", state.url, state.commandsHandled), COLOR_OK)
		end

		if response.command then
			setStatus(string.format("Fuehre aus: %s", tostring(response.command.action)), COLOR_OK)
			handleCommand(response.command)
			setStatus(string.format("Verbunden mit %s\nBefehle verarbeitet: %d", state.url, state.commandsHandled), COLOR_OK)
		else
			task.wait(POLL_IDLE_WAIT)
		end
	end
end

local function connect()
	state.url = urlBox.Text:gsub("/+$", "")
	state.token = tokenBox.Text

	if state.url == "" or state.token == "" then
		setStatus("Bitte URL und Token eintragen.\nBeide stehen in der ---BRIDGE--- Box beim Bridge-Start.", COLOR_ERR)
		return
	end

	plugin:SetSetting("NexusAI_Url", state.url)
	setStatus("Verbinde...", COLOR_IDLE)

	local ok, response = request("POST", "/studio/handshake", {
		clientId = state.clientId,
		name = "Roblox Studio",
		version = PLUGIN_VERSION,
		place = tostring(game.PlaceId),
	})

	if not ok then
		state.connected = false
		setStatus("Handshake fehlgeschlagen:\n" .. tostring(response), COLOR_ERR)
		return
	end

	state.connected = true
	state.running = true
	setStatus(string.format("Verbunden mit %s\nSession: %s", state.url, tostring(response.sessionId)), COLOR_OK)
	connectButton.Text = "Trennen"
	connectButton.BackgroundColor3 = Color3.fromRGB(255, 95, 109)

	task.spawn(pollLoop)
end

local function disconnect()
	state.running = false
	state.connected = false
	state.token = ""
	tokenBox.Text = ""
	connectButton.Text = "Verbinden"
	connectButton.BackgroundColor3 = Color3.fromRGB(79, 140, 255)
	setStatus("Getrennt.", COLOR_IDLE)
end

connectButton.MouseButton1Click:Connect(function()
	if state.running then
		disconnect()
	else
		connect()
	end
end)

toggleButton.Click:Connect(function()
	widget.Enabled = not widget.Enabled
end)

plugin.Unloading:Connect(function()
	state.running = false
end)

print(string.format("[%s] Plugin v%s geladen. Toolbar -> NexusAI Bridge oeffnen.", PLUGIN_NAME, PLUGIN_VERSION))
