"""Tests for extracted Leetcode-chat marker handling + queue hook."""


def test_apply_leetcode_actions_creates_and_cleans(db):
    from backend.routers.leetcode import apply_leetcode_actions
    from backend.models import LeetcodeProblem
    clean, created = apply_leetcode_actions(
        db,
        'Sure! [ADD_PROBLEM: name="Two Sum", number=1, url="https://leetcode.com/problems/two-sum/", category="Arrays & Hashing", difficulty="Easy"] Done.',
    )
    assert 'ADD_PROBLEM' not in clean
    assert len(created) == 1
    assert db.query(LeetcodeProblem).filter(LeetcodeProblem.name == "Two Sum").count() == 1


def test_leetcode_chat_hook(db):
    from backend.services import result_hooks, job_queue
    from backend.models import LeetcodeProblem
    job = job_queue.enqueue(db, context="leetcode_chat", task_type="chat", request_payload={"prompt": "x"})
    claimed = job_queue.claim_next(db)
    job_queue.record_result(
        db, claimed.job_id,
        response_text='[ADD_PROBLEM: name="Two Sum", category="Arrays & Hashing", difficulty="Easy"] ok',
    )
    result_hooks.run_hook(db, job_queue.get_job(db, claimed.job_id))
    assert db.query(LeetcodeProblem).filter(LeetcodeProblem.name == "Two Sum").count() == 1
    refreshed = job_queue.get_job(db, claimed.job_id)
    assert 'ADD_PROBLEM' not in (refreshed.response_text or '')     # cleaned text stored back


def test_leetcode_chat_hook_noop_for_hint_text(db):
    """Learning-mode hint responses have no markers — the hook must be a safe no-op."""
    from backend.services import result_hooks, job_queue
    job = job_queue.enqueue(db, context="leetcode_chat", task_type="chat", request_payload={"prompt": "x"})
    claimed = job_queue.claim_next(db)
    job_queue.record_result(db, claimed.job_id, response_text='Think about what data structure gives O(1) lookup.')
    result_hooks.run_hook(db, job_queue.get_job(db, claimed.job_id))
    refreshed = job_queue.get_job(db, claimed.job_id)
    assert refreshed.response_text == 'Think about what data structure gives O(1) lookup.'


def test_leetcode_chat_hook_persists_assistant_message(db):
    """The hook must write the assistant ChatMessage under the job's stashed
    context_key, so Learning Mode history isn't dropped (mirrors _save_advisor_reply)."""
    from backend.services import result_hooks, job_queue
    from backend.models import ChatMessage
    job = job_queue.enqueue(
        db, context="leetcode_chat", task_type="chat",
        request_payload={"prompt": "x", "context_key": "leetcode:7"},
    )
    claimed = job_queue.claim_next(db)
    job_queue.record_result(db, claimed.job_id, response_text='Think about a hash map.')
    result_hooks.run_hook(db, job_queue.get_job(db, claimed.job_id))
    saved = db.query(ChatMessage).filter(ChatMessage.context == "leetcode:7", ChatMessage.role == "assistant").all()
    assert len(saved) == 1
    assert saved[0].content == 'Think about a hash map.'


def test_leetcode_chat_async_persists_user_message_and_stashes_context_key(db, monkeypatch):
    """leetcode_chat_async must persist the user turn immediately (async can't wait
    for the hook) and stash context_key on the job so the hook can save the reply
    under the same key — otherwise Learning Mode history is lost across turns."""
    from backend.models import ChatMessage, LeetcodeProblem
    from backend.schemas import LeetcodeAdvisorChatRequest
    from backend.routers import async_jobs
    from backend.services.leetcode_service import LeetcodeAdvisorService

    problem = LeetcodeProblem(name="Two Sum", category="Arrays & Hashing", difficulty="Easy", status="todo")
    db.add(problem); db.commit(); db.refresh(problem)

    monkeypatch.setattr(
        LeetcodeAdvisorService, "hint_chat_prompt",
        lambda self, message, problem_context, history_text: ("prompt", object()),
    )
    captured = {}

    def _fake_enqueue(self, contents, config, *, task_type, context, method=None, context_key=None):
        captured["task_type"] = task_type
        captured["context"] = context
        captured["context_key"] = context_key
        return "fake-job-id"

    monkeypatch.setattr(LeetcodeAdvisorService, "_enqueue", _fake_enqueue)

    req = LeetcodeAdvisorChatRequest(message="give me a hint", problem_id=problem.id)
    resp = async_jobs.leetcode_chat_async(req, db=db)

    context_key = f"leetcode:{problem.id}"
    user_msgs = db.query(ChatMessage).filter(ChatMessage.context == context_key, ChatMessage.role == "user").all()
    assert len(user_msgs) == 1
    assert user_msgs[0].content == "give me a hint"

    assert resp.job_id == "fake-job-id"
    assert captured["context_key"] == context_key
    assert captured["task_type"] == "leetcode_hint"


def test_leetcode_chat_async_general_chat_uses_chat_task_type(db, monkeypatch):
    """General (non-Learning-Mode) chat must still route via task_type='chat',
    matching the sync path's service.chat -> _generate default."""
    from backend.schemas import LeetcodeAdvisorChatRequest
    from backend.routers import async_jobs
    from backend.services.leetcode_service import LeetcodeAdvisorService

    monkeypatch.setattr(
        LeetcodeAdvisorService, "chat_prompt",
        lambda self, message, lc_context, today: ("prompt", object()),
    )
    captured = {}

    def _fake_enqueue(self, contents, config, *, task_type, context, method=None, context_key=None):
        captured["task_type"] = task_type
        return "fake-job-id"

    monkeypatch.setattr(LeetcodeAdvisorService, "_enqueue", _fake_enqueue)

    req = LeetcodeAdvisorChatRequest(message="what should I practice next?", problem_id=None)
    async_jobs.leetcode_chat_async(req, db=db)

    assert captured["task_type"] == "chat"
