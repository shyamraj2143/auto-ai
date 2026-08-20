from __future__ import annotations

import random
import threading
import time
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from time import perf_counter

from app.core.config import settings
from app.services.orchestration.model_registry import model_registry
from app.services.orchestration.provider_adapters import provider_adapter
from app.services.orchestration.resilience import resilience_manager
from app.services.orchestration.schemas import ActivityCallback, CancelCallback, ModelResult, ModelTask, TaskStatus, utc_iso


class ParallelExecutor:
    def execute(
        self,
        tasks: list[ModelTask],
        *,
        emit: ActivityCallback,
        cancelled: CancelCallback,
        max_tokens: int,
        total_timeout: int,
    ) -> list[ModelResult]:
        if not tasks:
            return []
        # Every planned model is submitted immediately. Provider adapters and
        # resilience controls remain responsible for provider-specific backoff.
        workers = len(tasks)
        results: list[ModelResult] = []
        pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="orchestration")
        invalidated: set[str] = set()
        invalidation_lock = threading.Lock()
        try:
            futures: dict[Future[ModelResult], ModelTask] = {}
            for task in tasks:
                if cancelled():
                    break
                emit("model.queued", self._payload(task, TaskStatus.QUEUED))
                futures[
                    pool.submit(
                        self._run,
                        task,
                        emit,
                        cancelled,
                        max_tokens,
                        invalidated,
                        invalidation_lock,
                    )
                ] = task
            pending = set(futures)
            deadline = time.monotonic() + total_timeout
            while pending and not cancelled():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                done, pending = wait(
                    pending,
                    timeout=min(0.25, remaining),
                    return_when=FIRST_COMPLETED,
                )
                for future in done:
                    results.append(future.result())
            for future, task in futures.items():
                if future.done():
                    continue
                future.cancel()
                status = TaskStatus.CANCELLED if cancelled() else TaskStatus.TIMED_OUT
                with invalidation_lock:
                    invalidated.add(task.task_id)
                result = ModelResult(
                    task=task,
                    status=status,
                    error_classification=status.value,
                    completed_at=utc_iso(),
                )
                results.append(result)
                emit(f"model.{status.value}", self._payload(task, status))
        finally:
            pool.shutdown(wait=False, cancel_futures=True)
        return results

    def _run(
        self,
        task: ModelTask,
        emit: ActivityCallback,
        cancelled: CancelCallback,
        max_tokens: int,
        invalidated: set[str],
        invalidation_lock: threading.Lock,
    ) -> ModelResult:
        key = f"{task.model.provider}:{task.model.actual_model_id}"
        if not resilience_manager.available(key):
            result = ModelResult(task=task, status=TaskStatus.SKIPPED, error_classification="circuit_open")
            emit("model.skipped", self._payload(task, result.status))
            return result
        if cancelled():
            result = ModelResult(task=task, status=TaskStatus.CANCELLED, error_classification="cancelled")
            emit("model.cancelled", self._payload(task, result.status))
            return result
        start = perf_counter()
        started_at = utc_iso()
        emit("model.started", {**self._payload(task, TaskStatus.WORKING), "started_at": started_at})
        last_exc: Exception | None = None
        for attempt in range(settings.ORCHESTRATION_MAX_RETRIES + 1):
            if cancelled():
                result = ModelResult(task=task, status=TaskStatus.CANCELLED, error_classification="cancelled")
                emit("model.cancelled", self._payload(task, result.status))
                return result
            try:
                result = provider_adapter.complete(task, max_tokens=max_tokens)
                result.duration_ms = int((perf_counter() - start) * 1000)
                result.started_at = started_at
                result.completed_at = utc_iso()
                with invalidation_lock:
                    if task.task_id in invalidated:
                        return ModelResult(
                            task=task,
                            status=TaskStatus.CANCELLED if cancelled() else TaskStatus.TIMED_OUT,
                            duration_ms=result.duration_ms,
                            error_classification="cancelled" if cancelled() else "timeout",
                        )
                resilience_manager.success(key)
                model_registry.mark_result(task.model.provider, task.model.actual_model_id, success=True)
                emit("model.completed", {
                    **self._payload(task, result.status),
                    "started_at": result.started_at,
                    "completed_at": result.completed_at,
                    "duration_ms": result.duration_ms,
                })
                return result
            except Exception as exc:
                last_exc = exc
                with invalidation_lock:
                    if task.task_id in invalidated:
                        return ModelResult(
                            task=task,
                            status=TaskStatus.CANCELLED if cancelled() else TaskStatus.TIMED_OUT,
                            duration_ms=int((perf_counter() - start) * 1000),
                            error_classification="cancelled" if cancelled() else "timeout",
                        )
                if attempt >= settings.ORCHESTRATION_MAX_RETRIES or not resilience_manager.retryable(exc):
                    break
                time.sleep(min(1.5, 0.2 * (2**attempt) + random.random() * 0.1))
        resilience_manager.failure(key)
        model_registry.mark_result(task.model.provider, task.model.actual_model_id, success=False)
        classification = resilience_manager.classify(last_exc or RuntimeError())
        status = TaskStatus.TIMED_OUT if classification == "timeout" else TaskStatus.FAILED
        result = ModelResult(
            task=task,
            status=status,
            duration_ms=int((perf_counter() - start) * 1000),
            error_classification=classification,
            started_at=started_at,
            completed_at=utc_iso(),
        )
        emit(f"model.{status.value}", {
            **self._payload(task, status),
            "started_at": result.started_at,
            "completed_at": result.completed_at,
            "duration_ms": result.duration_ms,
            "failure_reason": classification,
        })
        return result

    @staticmethod
    def _payload(task: ModelTask, status: TaskStatus) -> dict:
        return {
            "task_id": task.task_id,
            "model_display_name": task.model.friendly_name,
            "actual_model_id": task.model.actual_model_id,
            "role": task.role,
            "activity_label": task.activity_label,
            "status": status.value,
        }


parallel_executor = ParallelExecutor()
