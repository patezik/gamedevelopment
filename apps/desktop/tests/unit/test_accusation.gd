extends GutTest
## Accusation (godot-client.md §4.4, ENG-006): the choice offered from the view, the `accuse`
## case file of the contract, the double confirmation (`confirm: false`, then `confirm: true`),
## cancelling, no repeated or wrong sending, server refusals and what follows a judged accusation.

const GameStoreScript = preload("res://src/autoload/game_store.gd")
const BackendScript = preload("res://src/autoload/backend.gd")
const SceneRouterScript = preload("res://src/autoload/scene_router.gd")
const AudioDirectorScript = preload("res://src/autoload/audio_director.gd")
const FakeBackend = preload("res://tests/unit/support/fake_backend.gd")
const Fixtures = preload("res://src/scenes/exploration/preview_fixtures.gd")
const EndingFixtures = preload("res://src/scenes/ending/ending_fixtures.gd")
const Contract = preload("res://tests/contract/contract_support.gd")
const AccusationScene = preload("res://src/scenes/accusation/accusation.tscn")
const Accusation = preload("res://src/scenes/accusation/accusation.gd")
const AccusationFormat = preload("res://src/scenes/accusation/accusation_format.gd")
const AccusationLedger = preload("res://src/scenes/accusation/accusation_ledger.gd")
const ExplorationScene = preload("res://src/scenes/exploration/exploration.tscn")

const FULL_FILE: Dictionary = {
	"accusedIds": ["ch_doctor"],
	"evidence": ["clue_note", "clue_logbook"],
	"motive": "motive(ch_doctor,ch_nurse)",
	"means": "means(ch_doctor)",
	"opportunity": "opportunity(ch_doctor)",
}

var _backend: FakeBackend
var _store: GameStoreScript
var _audio: AudioDirectorScript
var _view: Dictionary
var _version: int = 0
var _router: SceneRouterScript
var _host: Control
var _old_fade: float


func before_each() -> void:
	_audio = get_node(^"/root/AudioDirector") as AudioDirectorScript
	_audio.bind_store(null)
	_backend = FakeBackend.new()
	add_child_autofree(_backend)
	_store = get_node(^"/root/GameStore") as GameStoreScript
	_store.bind_backend(_backend)
	_backend.change_state(BackendScript.ConnectionState.ONLINE)
	_view = Fixtures.load_view("mid").duplicate(true)
	_version = 0
	# A view with `ending` opens the ending screen: keep the real router off the GUT scene.
	_router = get_node(^"/root/SceneRouter") as SceneRouterScript
	_host = Control.new()
	add_child_autofree(_host)
	_old_fade = _router.fade_seconds
	_router.host = _host
	_router.fade_seconds = 0.0
	# The ledger outlives screens on the scene root; every test starts without one.
	var ledger: Node = get_tree().root.get_node_or_null(NodePath(AccusationLedger.NODE_NAME))
	if ledger != null:
		get_tree().root.remove_child(ledger)
		ledger.free()
	get_tree().root.remove_meta(AccusationLedger.META_KEY)
	_backend.set_session_id("session-a")


func after_each() -> void:
	await wait_until(func() -> bool: return not _router.is_transitioning(), 2.0)
	_router.host = null
	_router.fade_seconds = _old_fade
	await get_tree().process_frame
	_store.bind_backend(get_node(^"/root/Backend") as BackendScript)
	_audio.bind_store(_store)


# --- helpers -----------------------------------------------------------------------------------


## Delivers [param view] (the mid view when empty) as the next view.update.
func _publish(view: Dictionary = {}) -> void:
	_version += 1
	var payload: Dictionary = view if not view.is_empty() else _view
	_backend.deliver(ProtocolConstants.MSG_VIEW_UPDATE, {"stateVersion": _version, "view": payload})


func _result(ok: bool, error: String = ProtocolConstants.ERROR_ACTION_INVALID, id: String = "") -> void:
	var request_id: String = id if not id.is_empty() else "desktop-%d" % _backend.sent.size()
	var result: Dictionary = {"ok": ok, "requestId": request_id, "minutesSpent": 0}
	if not ok:
		result["error"] = error
	_backend.deliver(ProtocolConstants.MSG_ACTION_RESULT, result)


## A screen mounted like SceneRouter does it, on the live store with the mid view.
func _live(params: Dictionary = {"back": "case_board"}) -> Accusation:
	_publish()
	var screen: Accusation = AccusationScene.instantiate() as Accusation
	screen.set_params(params)
	add_child_autofree(screen)
	return screen


func _fill(screen: Accusation) -> void:
	screen.set_accused(["ch_doctor"])
	screen.set_claim("motive", "ch_doctor", "ch_nurse")
	screen.set_claim("means", "ch_doctor")
	screen.set_claim("opportunity", "ch_doctor")
	screen.set_evidence(["clue_note", "clue_logbook"])


func _assert_action(action: Dictionary, confirm: bool) -> void:
	assert_eq(action, {"type": "accuse", "caseFile": FULL_FILE, "confirm": confirm})
	var problems: Array = Contract.shape_problems(action, Contract.schema("player-action.json"), "$")
	assert_true(problems.is_empty(), "the action matches the PlayerAction schema: %s" % [problems])
	assert_eq(GameStoreScript.find_forbidden_key(action), "")


## Fills the case, confirms the first dialog and lets the server accept `confirm: false`.
func _reach_final(screen: Accusation) -> void:
	_fill(screen)
	assert_eq(screen.request_accusation(), OK)
	screen.get_first_dialog().confirmed.emit()
	_result(true)


# --- choice ------------------------------------------------------------------------------------


func test_offers_the_characters_and_clues_the_view_names() -> void:
	var screen: Accusation = _live()
	var ids: Array[String] = []
	for character: Dictionary in screen.get_characters():
		ids.append(str(character["id"]))
	assert_eq(ids, ["ch_doctor", "ch_nurse"] as Array[String])
	assert_eq(str(screen.get_characters()[0]["name"]), "Доктор Белов")
	assert_eq(screen.get_clue_ids(), ["clue_note", "clue_footprints", "clue_logbook", "clue_nurse_alibi", "clue_voicemail"] as Array[String])
	assert_false(screen.is_preview())


func test_case_file_follows_the_contract() -> void:
	var screen: Accusation = _live()
	_fill(screen)
	assert_eq(screen.get_case_file(), FULL_FILE)


func test_claims_only_about_the_accused_and_known_characters() -> void:
	var screen: Accusation = _live()
	screen.set_accused(["ch_doctor", "ch_stranger"])
	assert_eq(screen.get_accused(), ["ch_doctor"] as Array[String], "an id the view does not name is ignored")
	screen.set_claim("means", "ch_nurse")
	screen.set_claim("motive", "ch_doctor", "ch_stranger")
	screen.set_evidence(["clue_note", "clue_unknown"])
	assert_eq(screen.get_case_file(), {"accusedIds": ["ch_doctor"], "evidence": ["clue_note"]})
	screen.set_claim("opportunity", "ch_doctor")
	screen.set_accused(["ch_nurse"])
	assert_false(screen.get_case_file().has("opportunity"), "a claim about someone no longer accused drops")


func test_selection_survives_a_view_update_and_drops_what_the_view_lost() -> void:
	var screen: Accusation = _live()
	_fill(screen)
	var updated: Dictionary = _view.duplicate(true)
	var clues: Array = (updated["caseBoard"] as Dictionary)["clues"]
	clues.remove_at(2)  # clue_logbook
	_publish(updated)
	var expected: Dictionary = FULL_FILE.duplicate(true)
	expected["evidence"] = ["clue_note"]
	assert_eq(screen.get_case_file(), expected)


func test_incomplete_choice_is_not_sent() -> void:
	var screen: Accusation = _live()
	assert_true(screen.get_accuse_button().disabled, "nothing to accuse without an accused")
	assert_eq(screen.request_accusation(), ERR_INVALID_DATA)
	assert_string_contains(screen.get_error_text(), "обвиняемого")
	screen.set_accused(["ch_doctor"])
	screen.set_claim("motive", "ch_doctor")
	assert_eq(screen.request_accusation(), ERR_INVALID_DATA, "a motive needs whom it was against")
	assert_string_contains(screen.get_error_text(), "против кого")
	assert_false(screen.get_first_dialog().visible)
	assert_eq(_backend.sent.size(), 0)


func test_missing_parts_are_listed_in_the_first_confirmation() -> void:
	var screen: Accusation = _live()
	screen.set_accused(["ch_nurse"])
	assert_eq(screen.request_accusation(), OK)
	var text: String = screen.get_first_dialog().dialog_text
	assert_string_contains(text, "медсестра")
	assert_string_contains(text, "Не указано: мотив, средство, возможность, улики")
	assert_eq(AccusationFormat.missing_parts(FULL_FILE), [] as Array[String])


# --- double confirmation -----------------------------------------------------------------------


func test_double_confirmation_sends_probe_then_the_accusation() -> void:
	var screen: Accusation = _live()
	_fill(screen)
	assert_eq(screen.request_accusation(), OK)
	assert_true(screen.get_first_dialog().visible, "the first confirmation opens")
	assert_eq(_backend.sent.size(), 0, "nothing is sent before the first confirmation")
	assert_eq(screen.get_stage(), Accusation.Stage.CONFIRMING)
	assert_true(screen.get_accuse_button().disabled)

	screen.get_first_dialog().confirmed.emit()
	assert_eq(_backend.sent.size(), 1)
	_assert_action(_backend.sent[0], false)
	assert_eq(screen.get_stage(), Accusation.Stage.PROBING)
	assert_false(screen.get_final_dialog().visible, "the final confirmation waits for the server")

	_result(true)
	assert_eq(screen.get_stage(), Accusation.Stage.FINAL)
	assert_true(screen.get_final_dialog().visible, "the final confirmation opens")
	assert_string_contains(screen.get_final_dialog().dialog_text, "необратимо")
	assert_eq(_backend.sent.size(), 1)

	screen.get_final_dialog().confirmed.emit()
	assert_eq(_backend.sent.size(), 2)
	_assert_action(_backend.sent[1], true)
	assert_eq(screen.get_stage(), Accusation.Stage.SUBMITTING)


func test_cancelling_the_first_confirmation_sends_nothing() -> void:
	var screen: Accusation = _live()
	_fill(screen)
	screen.request_accusation()
	screen.get_first_dialog().canceled.emit()
	assert_eq(screen.get_stage(), Accusation.Stage.EDITING)
	assert_eq(_backend.sent.size(), 0)
	screen.get_first_dialog().confirmed.emit()
	assert_eq(_backend.sent.size(), 0, "a stale confirmation after cancel sends nothing")
	assert_eq(screen.get_case_file(), FULL_FILE, "the choice is kept")
	assert_false(screen.get_accuse_button().disabled)


func test_cancelling_the_final_confirmation_never_sends_confirm_true() -> void:
	var screen: Accusation = _live()
	_reach_final(screen)
	screen.get_final_dialog().canceled.emit()
	assert_eq(screen.get_stage(), Accusation.Stage.EDITING)
	screen.get_final_dialog().confirmed.emit()
	assert_eq(_backend.sent.size(), 1, "only the harmless confirm:false went out")
	var probe: Dictionary = _backend.sent[0]
	assert_eq(probe, {"type": "accuse", "caseFile": FULL_FILE, "confirm": false})
	assert_eq(screen.get_case_file(), FULL_FILE, "the choice is kept")


func test_no_repeated_sending_while_in_flight() -> void:
	var screen: Accusation = _live()
	_fill(screen)
	screen.request_accusation()
	var first: ConfirmationDialog = screen.get_first_dialog()
	first.confirmed.emit()
	first.confirmed.emit()
	assert_eq(_backend.sent.size(), 1, "a double click on the first confirmation sends one probe")
	assert_eq(screen.request_accusation(), ERR_BUSY)
	_result(true)
	var final_dialog: ConfirmationDialog = screen.get_final_dialog()
	final_dialog.confirmed.emit()
	final_dialog.confirmed.emit()
	assert_eq(_backend.sent.size(), 2, "a double click on the final confirmation sends one accusation")
	assert_eq(screen.request_accusation(), ERR_BUSY)
	screen.set_accused(["ch_nurse"])
	assert_eq(screen.get_accused(), ["ch_doctor"] as Array[String], "the choice is locked in flight")
	_result(true)
	assert_eq(screen.get_stage(), Accusation.Stage.AWAITING_VIEW)
	assert_eq(screen.request_accusation(), ERR_BUSY)
	assert_eq(_backend.sent.size(), 2)


func test_a_result_for_another_request_is_ignored() -> void:
	var screen: Accusation = _live()
	_fill(screen)
	screen.request_accusation()
	screen.get_first_dialog().confirmed.emit()
	_result(true, "", "desktop-99")
	assert_eq(screen.get_stage(), Accusation.Stage.PROBING)
	assert_false(screen.get_final_dialog().visible)


# --- refusals ----------------------------------------------------------------------------------


func test_server_refusal_of_the_probe_keeps_the_choice() -> void:
	var screen: Accusation = _live()
	_fill(screen)
	screen.request_accusation()
	screen.get_first_dialog().confirmed.emit()
	_result(false, ProtocolConstants.ERROR_ACTION_NOT_AVAILABLE)
	assert_eq(screen.get_stage(), Accusation.Stage.EDITING)
	assert_string_contains(screen.get_error_text(), "недоступно")
	assert_false(screen.get_final_dialog().visible, "a refused probe never opens the final confirmation")
	assert_eq(screen.get_case_file(), FULL_FILE)
	assert_eq(_backend.sent.size(), 1)


func test_server_refusal_of_the_accusation_allows_a_corrected_retry() -> void:
	var screen: Accusation = _live()
	_reach_final(screen)
	screen.get_final_dialog().confirmed.emit()
	_result(false, ProtocolConstants.ERROR_ACTION_INVALID)
	assert_eq(screen.get_stage(), Accusation.Stage.EDITING)
	assert_string_contains(screen.get_error_text(), "отклонил")
	screen.set_evidence(["clue_note"])
	assert_eq(screen.request_accusation(), OK, "the player may correct and try again")
	screen.get_first_dialog().confirmed.emit()
	assert_eq(_backend.sent.size(), 3)
	assert_eq(str((_backend.sent[2]["caseFile"] as Dictionary)["evidence"]), str(["clue_note"]))
	var retry: Dictionary = _backend.sent[2]
	assert_false(retry["confirm"] as bool, "a retry starts with a new confirmation")


func test_an_error_message_with_the_request_id_is_a_refusal() -> void:
	var screen: Accusation = _live()
	_reach_final(screen)
	screen.get_final_dialog().confirmed.emit()
	_backend.deliver(ProtocolConstants.MSG_ERROR, {
		"code": ProtocolConstants.ERROR_GAME_OVER, "message": "over", "requestId": "desktop-2",
	})
	assert_eq(screen.get_stage(), Accusation.Stage.EDITING)
	assert_string_contains(screen.get_error_text(), "Игра окончена")


func test_send_failure_without_a_connection() -> void:
	var screen: Accusation = _live()
	_fill(screen)
	_backend.send_result = ERR_CONNECTION_ERROR
	screen.request_accusation()
	screen.get_first_dialog().confirmed.emit()
	assert_eq(screen.get_stage(), Accusation.Stage.EDITING)
	assert_string_contains(screen.get_error_text(), "Нет соединения")
	assert_eq(_backend.sent.size(), 0)


func test_connection_loss_during_the_probe_needs_a_new_confirmation() -> void:
	var screen: Accusation = _live()
	_fill(screen)
	screen.request_accusation()
	screen.get_first_dialog().confirmed.emit()
	_backend.change_state(BackendScript.ConnectionState.RETRYING)
	assert_eq(screen.get_stage(), Accusation.Stage.EDITING, "confirm:false is harmless; start over")
	assert_string_contains(screen.get_error_text(), "Связь")
	_backend.change_state(BackendScript.ConnectionState.ONLINE)
	_result(true)
	assert_false(screen.get_final_dialog().visible, "a probe answer after the drop opens nothing")
	assert_eq(screen.get_case_file(), FULL_FILE, "the choice of the same session is kept")


# --- regression: an executed accusation must never be sent again (review P1-1) ------------------


func test_lost_result_after_confirm_true_blocks_a_second_accusation() -> void:
	var screen: Accusation = _live()
	_reach_final(screen)
	screen.get_final_dialog().confirmed.emit()
	assert_eq(_backend.sent.size(), 2)
	# The server executed it (a forgiven wrong accusation), the socket dropped before action.result,
	# the resume brought only the snapshot: no ending, no result.
	_backend.change_state(BackendScript.ConnectionState.RETRYING)
	assert_eq(screen.get_stage(), Accusation.Stage.UNKNOWN)
	_backend.change_state(BackendScript.ConnectionState.ONLINE)
	_publish()
	assert_eq(screen.get_stage(), Accusation.Stage.UNKNOWN, "a new stateVersion proves nothing")
	assert_eq(screen.request_accusation(), ERR_UNAVAILABLE)
	assert_true(screen.get_accuse_button().disabled)
	assert_false(screen.get_first_dialog().visible)
	assert_true(screen.can_go_back(), "the player is not trapped")
	assert_string_contains(screen.get_status_text(), "неизвестен")
	assert_eq(_backend.sent.size(), 2, "nothing is re-sent, automatically or by hand")


func test_unknown_outcome_survives_reopening_the_screen() -> void:
	var screen: Accusation = _live()
	_reach_final(screen)
	screen.get_final_dialog().confirmed.emit()
	_backend.change_state(BackendScript.ConnectionState.RETRYING)
	_backend.change_state(BackendScript.ConnectionState.ONLINE)
	screen.free()
	var again: Accusation = AccusationScene.instantiate() as Accusation
	again.set_params({"back": "case_board"})
	add_child_autofree(again)
	assert_eq(again.get_stage(), Accusation.Stage.UNKNOWN)
	_fill(again)
	assert_eq(again.request_accusation(), ERR_UNAVAILABLE)
	assert_eq(_backend.sent.size(), 2)


func test_unknown_outcome_resolves_when_the_game_ends() -> void:
	var screen: Accusation = _live()
	_reach_final(screen)
	screen.get_final_dialog().confirmed.emit()
	_backend.change_state(BackendScript.ConnectionState.RETRYING)
	_backend.change_state(BackendScript.ConnectionState.ONLINE)
	_publish(EndingFixtures.view_for("wrong_accusation").duplicate(true))
	assert_eq(screen.get_stage(), Accusation.Stage.ENDED)
	await wait_until(func() -> bool: return not _router.is_transitioning(), 2.0)
	assert_eq(_router.get_current_screen(), &"ending")


func test_result_timeout_is_unknown_and_a_late_result_still_counts() -> void:
	var screen: Accusation = _live()
	_reach_final(screen)
	screen.get_final_dialog().confirmed.emit()
	var ledger: Node = screen.get_ledger()
	ledger.call(&"advance", AccusationLedger.RESULT_TIMEOUT_SECONDS)
	assert_eq(screen.get_stage(), Accusation.Stage.UNKNOWN)
	assert_eq(screen.request_accusation(), ERR_UNAVAILABLE)
	_result(true)  # the late answer of the same request on the same connection
	assert_eq(screen.get_stage(), Accusation.Stage.AWAITING_VIEW)
	_publish()
	assert_eq(screen.get_stage(), Accusation.Stage.EDITING, "the game went on: a known outcome")
	assert_string_contains(screen.get_status_text(), "продолжается")


# --- regression: the view after an accepted accusation may not come (review P2) ----------------


func test_missing_view_after_an_accepted_accusation_unlocks_the_way_back_only() -> void:
	var screen: Accusation = _live()
	_reach_final(screen)
	screen.get_final_dialog().confirmed.emit()
	_result(true)
	assert_eq(screen.get_stage(), Accusation.Stage.AWAITING_VIEW)
	assert_false(screen.can_go_back(), "an answer is due shortly")
	screen.get_ledger().call(&"advance", AccusationLedger.VIEW_TIMEOUT_SECONDS)
	assert_eq(_store.get_connection_state(), BackendScript.ConnectionState.ONLINE, "still online")
	assert_true(screen.can_go_back(), "the player is not trapped")
	assert_false((screen.find_child("Back", true, false) as Button).disabled)
	assert_eq(screen.request_accusation(), ERR_BUSY, "no new accusation before the state arrives")
	assert_string_contains(screen.get_status_text(), "принял")
	_publish()
	assert_eq(screen.get_stage(), Accusation.Stage.EDITING)
	assert_eq(_backend.sent.size(), 2)


# --- regression: nothing confirmed in one session reaches another (review P1-2) ----------------


func _session_b() -> void:
	_backend.change_state(BackendScript.ConnectionState.OFFLINE)
	_backend.set_session_id("session-b")
	_backend.change_state(BackendScript.ConnectionState.ONLINE)
	_version = 0
	_publish()  # session B: the same character ids


func test_final_confirmation_of_session_a_never_reaches_session_b() -> void:
	var screen: Accusation = _live()
	_reach_final(screen)
	assert_true(screen.get_final_dialog().visible)
	_session_b()
	assert_false(screen.get_final_dialog().visible, "the dialog of session A is closed")
	screen.get_final_dialog().confirmed.emit()
	assert_eq(_backend.sent.size(), 1, "session B got no confirm:true")
	assert_eq(screen.get_accused(), [] as Array[String], "the choice of session A is gone")
	assert_eq(screen.get_stage(), Accusation.Stage.EDITING)


func test_first_confirmation_of_session_a_never_reaches_session_b() -> void:
	var screen: Accusation = _live()
	_fill(screen)
	screen.request_accusation()
	_session_b()
	screen.get_first_dialog().confirmed.emit()
	assert_eq(_backend.sent.size(), 0)


func test_session_change_without_offline_is_caught_before_sending() -> void:
	var screen: Accusation = _live()
	_reach_final(screen)
	_backend.set_session_id("session-b")
	screen.get_final_dialog().confirmed.emit()
	assert_eq(_backend.sent.size(), 1, "confirm:true is not sent into another session")
	assert_string_contains(screen.get_error_text(), "Сессия сменилась")


func test_late_answers_of_session_a_do_not_touch_session_b() -> void:
	var screen: Accusation = _live()
	_fill(screen)
	screen.request_accusation()
	screen.get_first_dialog().confirmed.emit()
	_session_b()
	_result(true, "", "desktop-1")
	assert_false(screen.get_final_dialog().visible, "a late probe answer opens nothing")
	assert_eq(screen.get_stage(), Accusation.Stage.EDITING)


func test_a_pending_accusation_of_session_a_does_not_block_session_b() -> void:
	var screen: Accusation = _live()
	_reach_final(screen)
	screen.get_final_dialog().confirmed.emit()
	_session_b()
	assert_eq(screen.get_stage(), Accusation.Stage.EDITING)
	_result(true, "", "desktop-2")  # the late result of session A
	assert_eq(screen.get_stage(), Accusation.Stage.EDITING)
	_fill(screen)
	assert_eq(screen.request_accusation(), OK, "session B starts clean")


# --- several accused (review: CaseFile unchanged in both phases) --------------------------------


func test_several_accused_go_out_unchanged_in_both_phases() -> void:
	var screen: Accusation = _live()
	screen.set_accused(["ch_doctor", "ch_nurse"])
	screen.set_claim("motive", "ch_nurse", "ch_doctor")
	screen.set_claim("means", "ch_doctor")
	screen.set_evidence(["clue_voicemail", "clue_note"])
	var expected: Dictionary = {
		"accusedIds": ["ch_doctor", "ch_nurse"],
		"evidence": ["clue_voicemail", "clue_note"],
		"motive": "motive(ch_nurse,ch_doctor)",
		"means": "means(ch_doctor)",
	}
	assert_eq(screen.get_case_file(), expected)
	screen.request_accusation()
	screen.get_first_dialog().confirmed.emit()
	_result(true)
	screen.get_final_dialog().confirmed.emit()
	assert_eq(_backend.sent.size(), 2)
	for index: int in 2:
		var action: Dictionary = _backend.sent[index]
		var file: Dictionary = action["caseFile"]
		assert_eq(file, expected, "phase %d carries the same case file" % index)
		var problems: Array = Contract.shape_problems(action, Contract.schema("player-action.json"), "$")
		assert_true(problems.is_empty(), "phase %d matches the schema: %s" % [index, problems])
	var probe: Dictionary = _backend.sent[0]
	var final: Dictionary = _backend.sent[1]
	assert_false(probe["confirm"] as bool)
	assert_true(final["confirm"] as bool)


# --- after the judgement -----------------------------------------------------------------------


func test_a_forgiven_accusation_lets_the_investigation_go_on() -> void:
	var screen: Accusation = _live()
	_reach_final(screen)
	screen.get_final_dialog().confirmed.emit()
	_result(true)
	_publish()
	assert_eq(screen.get_stage(), Accusation.Stage.EDITING)
	assert_string_contains(screen.get_status_text(), "продолжается")
	assert_eq(_backend.sent.size(), 2)


func test_an_ending_view_locks_the_screen() -> void:
	var screen: Accusation = _live({})
	_reach_final(screen)
	screen.get_final_dialog().confirmed.emit()
	_result(true)
	_publish(EndingFixtures.view_for("solved").duplicate(true))
	assert_eq(screen.get_stage(), Accusation.Stage.ENDED)
	assert_true(screen.get_accuse_button().disabled)
	assert_eq(screen.request_accusation(), ERR_UNAVAILABLE)
	assert_eq(_backend.sent.size(), 2)


func test_preview_never_sends() -> void:
	var screen: Accusation = AccusationScene.instantiate() as Accusation
	screen.set_params({"preview": "mid"})
	add_child_autofree(screen)
	assert_true(screen.is_preview())
	assert_eq(screen.get_characters().size(), 2)
	screen.set_accused(["ch_doctor"])
	assert_eq(screen.request_accusation(), ERR_UNAVAILABLE)
	assert_true(screen.get_accuse_button().disabled)
	assert_eq(_backend.sent.size(), 0)


func test_a_view_with_server_only_fields_is_not_shown() -> void:
	var screen: Accusation = _live()
	var leaked: Dictionary = _view.duplicate(true)
	leaked["truth"] = {"culpritIds": ["ch_doctor"]}
	assert_false(_store.set_view(leaked, 50), "the store refuses it")
	assert_push_error("server-only field 'truth'")
	screen.call(&"_show", leaked)
	assert_push_error_count(2, "the screen refuses it too")
	assert_eq(screen.get_characters().size(), 0)
	screen.call(&"_show", _store.get_view())
	assert_eq(screen.get_characters().size(), 2, "the screen keeps the last legal view")


func test_format_claim_refs() -> void:
	assert_eq(AccusationFormat.claim_ref("motive", "ch_a", "ch_b"), "motive(ch_a,ch_b)")
	assert_eq(AccusationFormat.claim_ref("motive", "ch_a"), "")
	assert_eq(AccusationFormat.claim_ref("means", "ch_a"), "means(ch_a)")
	assert_eq(AccusationFormat.claim_ref("opportunity", "ch_a", "ignored"), "opportunity(ch_a)")
	assert_eq(AccusationFormat.claim_ref("alibi", "ch_a"), "")
	assert_eq(AccusationFormat.claim_ref("means", ""), "")
	assert_eq(
		AccusationFormat.case_file(["a", "a", ""] as Array[String], {"means": ""}, ["c", "c"] as Array[String]),
		{"accusedIds": ["a"], "evidence": ["c"]},
	)
