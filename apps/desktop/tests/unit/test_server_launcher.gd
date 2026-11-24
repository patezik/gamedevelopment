extends GutTest

const ServerLauncher = preload("res://src/autoload/server_launcher.gd")


func test_pick_port_returns_preferred_when_free() -> void:
	assert_eq(ServerLauncher.pick_port(func(_p: int) -> bool: return true), 7420)


func test_pick_port_skips_busy_ports() -> void:
	var busy: Array[int] = [7420, 7421]
	var is_free: Callable = func(p: int) -> bool: return not busy.has(p)
	assert_eq(ServerLauncher.pick_port(is_free), 7422)


func test_pick_port_gives_up_after_the_scan_range() -> void:
	assert_eq(ServerLauncher.pick_port(func(_p: int) -> bool: return false), -1)
	var only_last: Callable = func(p: int) -> bool: return p == 7439
	assert_eq(ServerLauncher.pick_port(only_last), 7439)
	var beyond: Callable = func(p: int) -> bool: return p == 7440
	assert_eq(ServerLauncher.pick_port(beyond), -1)


func test_pick_port_does_not_pass_the_port_limit() -> void:
	assert_eq(ServerLauncher.pick_port(func(p: int) -> bool: return p > 65535, 65530, 20), -1)


func test_probe_port_detects_an_occupied_port() -> void:
	var taken: int = ServerLauncher.pick_port(ServerLauncher.probe_port, 47420, 50)
	assert_gt(taken, 0)
	var busy: TCPServer = TCPServer.new()
	assert_eq(busy.listen(taken, "0.0.0.0"), OK)
	assert_false(ServerLauncher.probe_port(taken))
	assert_eq(ServerLauncher.pick_port(ServerLauncher.probe_port, taken, 50), taken + 1)
	busy.stop()
	assert_true(ServerLauncher.probe_port(taken))


func test_binary_name_depends_on_platform() -> void:
	assert_eq(ServerLauncher.binary_file_name("Windows"), "hollow-signal-server.exe")
	assert_eq(ServerLauncher.binary_file_name("Linux"), "hollow-signal-server")
	assert_eq(ServerLauncher.binary_file_name("macOS"), "hollow-signal-server")


func test_health_body_must_report_ok() -> void:
	assert_true(ServerLauncher.is_healthy_body('{"status":"ok","version":"0.0.0"}'))
	assert_false(ServerLauncher.is_healthy_body('{"status":"error"}'))
	assert_false(ServerLauncher.is_healthy_body("<html></html>"))
	assert_false(ServerLauncher.is_healthy_body("[]"))
	assert_false(ServerLauncher.is_healthy_body(""))


func test_health_url_targets_loopback() -> void:
	assert_eq(ServerLauncher.health_url(7421), "http://127.0.0.1:7421/api/v1/health")


func test_start_fails_for_a_missing_binary() -> void:
	var launcher: ServerLauncher = ServerLauncher.new()
	add_child_autofree(launcher)
	watch_signals(launcher)
	assert_ne(launcher.start("/nonexistent/hollow-signal-server"), OK)
	assert_eq(launcher.state, ServerLauncher.State.FAILED)
	assert_signal_emitted(launcher, "server_failed")


func test_real_server_starts_and_stops_with_the_launcher() -> void:
	var binary: String = OS.get_environment("HS_SERVER_BIN")
	if binary.is_empty():
		pending("Set HS_SERVER_BIN to a built server (npm run build -w @hs/server) to run this test")
		return
	var launcher: ServerLauncher = ServerLauncher.new()
	add_child_autofree(launcher)
	watch_signals(launcher)
	assert_eq(launcher.start(binary, 47500), OK)
	var pid: int = launcher._pid
	await wait_for_signal(launcher.server_ready, 25.0)
	assert_signal_emitted(launcher, "server_ready")
	assert_eq(launcher.state, ServerLauncher.State.READY)
	assert_true(OS.is_process_running(pid))
	assert_false(ServerLauncher.probe_port(47500))
	assert_eq(ServerLauncher.pick_port(ServerLauncher.probe_port, 47500), 47501)
	launcher.stop()
	await wait_seconds(0.5)
	assert_true(ServerLauncher.probe_port(47500))
