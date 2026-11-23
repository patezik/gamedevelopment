extends Node
## Starts the bundled Session Server (Node SEA) as a child process and waits for /api/v1/health.
## Without a bundled binary (editor, development) it stays idle: run `npm run dev -w @hs/server`.

signal server_ready(port: int)
signal server_failed(reason: String)

enum State { IDLE, STARTING, READY, FAILED }

const DEFAULT_PORT: int = 7420
const PORT_SCAN_COUNT: int = 20
const HEALTH_TIMEOUT_SECONDS: float = 20.0
const HEALTH_POLL_SECONDS: float = 0.25
const BINARY_DIRECTORY: String = "server"
const BINARY_NAME: String = "hollow-signal-server"

var state: State = State.IDLE
var port: int = 0

var _pid: int = -1
var _elapsed: float = 0.0
var _since_poll: float = 0.0
var _http: HTTPRequest
var _request_pending: bool = false


## First free port in [preferred, preferred + count), or -1. `is_free` takes a port and returns bool.
static func pick_port(is_free: Callable, preferred: int = DEFAULT_PORT, count: int = PORT_SCAN_COUNT) -> int:
	for candidate: int in range(preferred, mini(preferred + count, 65536)):
		var free: Variant = is_free.call(candidate)
		if free is bool and free:
			return candidate
	return -1


static func probe_port(candidate: int) -> bool:
	var listener: TCPServer = TCPServer.new()
	if listener.listen(candidate) != OK:
		return false
	listener.stop()
	return true


static func binary_file_name(os_name: String = OS.get_name()) -> String:
	return BINARY_NAME + (".exe" if os_name == "Windows" else "")


## `<game directory>/server/hollow-signal-server[.exe]`; the export layout is defined by REL-001.
static func default_binary_path() -> String:
	return OS.get_executable_path().get_base_dir().path_join(BINARY_DIRECTORY).path_join(binary_file_name())


static func health_url(server_port: int) -> String:
	return "http://127.0.0.1:%d/api/v1/health" % server_port


static func is_healthy_body(body: String) -> bool:
	var json: JSON = JSON.new()
	if json.parse(body) != OK:
		return false
	var data: Variant = json.data
	return data is Dictionary and str((data as Dictionary).get("status", "")) == "ok"


func base_url() -> String:
	return "http://127.0.0.1:%d" % port


func _ready() -> void:
	_http = HTTPRequest.new()
	_http.timeout = 2.0
	add_child(_http)
	_http.request_completed.connect(_on_health_completed)
	var binary: String = default_binary_path()
	if FileAccess.file_exists(binary):
		start(binary)


func start(binary: String, preferred_port: int = DEFAULT_PORT) -> Error:
	if state == State.STARTING or state == State.READY:
		return ERR_ALREADY_IN_USE
	if not FileAccess.file_exists(binary):
		return _fail("Server binary not found: %s" % binary, ERR_FILE_NOT_FOUND)
	var chosen: int = pick_port(probe_port, preferred_port)
	if chosen < 0:
		return _fail("No free port near %d" % preferred_port, ERR_CANT_CREATE)
	# The child inherits the environment of this process.
	OS.set_environment("HS_PORT", str(chosen))
	OS.set_environment("HS_PARENT_PID", str(OS.get_process_id()))
	_pid = OS.create_process(binary, PackedStringArray())
	if _pid < 0:
		return _fail("Cannot start %s" % binary, ERR_CANT_FORK)
	port = chosen
	state = State.STARTING
	_elapsed = 0.0
	_since_poll = HEALTH_POLL_SECONDS
	return OK


func stop() -> void:
	if _pid >= 0 and OS.is_process_running(_pid):
		OS.kill(_pid)
	_pid = -1
	if state != State.FAILED:
		state = State.IDLE


func _process(delta: float) -> void:
	if state != State.STARTING:
		return
	_elapsed += delta
	if not OS.is_process_running(_pid):
		_fail("The server process exited during startup")
		return
	if _elapsed >= HEALTH_TIMEOUT_SECONDS:
		stop()
		_fail("The server did not answer /health within %d s" % int(HEALTH_TIMEOUT_SECONDS))
		return
	_since_poll += delta
	if _request_pending or _since_poll < HEALTH_POLL_SECONDS:
		return
	_since_poll = 0.0
	_request_pending = true
	if _http.request(health_url(port)) != OK:
		_request_pending = false


func _on_health_completed(
	result: int, status: int, _headers: PackedStringArray, body: PackedByteArray
) -> void:
	_request_pending = false
	if state != State.STARTING:
		return
	if result == HTTPRequest.RESULT_SUCCESS and status == 200 \
			and is_healthy_body(body.get_string_from_utf8()):
		state = State.READY
		server_ready.emit(port)


func _fail(reason: String, code: Error = FAILED) -> Error:
	state = State.FAILED
	push_warning("ServerLauncher: " + reason)
	server_failed.emit(reason)
	return code


func _exit_tree() -> void:
	stop()
