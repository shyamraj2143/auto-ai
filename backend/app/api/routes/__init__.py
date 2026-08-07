"""API routes and additive router registration."""

# AutoAI Seva extends the existing form-services router so the main app keeps one
# authoritative service API registration point. Importing the routes package
# happens before main.py includes form_services.router.
from app.api.routes import form_services as _form_services
from app.api.routes.seva_operations import router as _seva_operations_router
from app.api.routes.seva_scope import router as _seva_scope_router

_form_services.router.include_router(_seva_operations_router)
_form_services.router.include_router(_seva_scope_router)

