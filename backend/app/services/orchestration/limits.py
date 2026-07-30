MAX_PARTICIPATING_MODELS = 6


def participating_model_limit(value: int | None, *, default: int = MAX_PARTICIPATING_MODELS) -> int:
    configured = default if value is None else value
    return max(1, min(int(configured), MAX_PARTICIPATING_MODELS))
