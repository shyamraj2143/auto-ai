import hashlib
import hmac
import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.intent_engine import IntentEvent, RequirementRecord, WorkflowRun
from app.schemas.intent_engine import (
    ActionType, DynamicInteraction, IntentClassification, IntentRequest, InteractionField,
    PolicyDecision, RiskLevel, RouterOutcome, WorkflowDefinitionSchema,
)

INTENT_INTERPRETER_PROMPT_VERSION = "intent-interpreter-v1"
WORKFLOW_PLANNER_PROMPT_VERSION = "workflow-planner-v1"
RESPONSE_COMPOSER_PROMPT_VERSION = "response-composer-v1"
MEMORY_EXTRACTOR_PROMPT_VERSION = "memory-extractor-v1"

SECRET_PATTERN = re.compile(r"\b(?:otp|password|passcode|pin)\s*[:=-]?\s*\d{4,12}\b", re.I)
TIME_PATTERN = re.compile(r"\b(?:at\s*)?(?:([01]?\d|2[0-3])[:.]([0-5]\d)|([1-9]|1[0-2])\s*(am|pm))\b", re.I)
STATE_TRANSITIONS={
    "RECEIVED":{"INTERPRETING","CANCELLED"},"INTERPRETING":{"INTENT_DETECTED","CLARIFICATION_REQUIRED","FAILED_RECOVERABLE"},
    "INTENT_DETECTED":{"REQUIREMENTS_ANALYSIS","CANCELLED"},"REQUIREMENTS_ANALYSIS":{"COLLECTING_INFORMATION","COLLECTING_DOCUMENTS","PERMISSION_REQUIRED","AUTHENTICATION_REQUIRED","READY_FOR_ACTION","CONFIRMATION_REQUIRED","FAILED_RECOVERABLE","CANCELLED"},
    "COLLECTING_INFORMATION":{"REQUIREMENTS_ANALYSIS","PAUSED","CANCELLED"},"COLLECTING_DOCUMENTS":{"REQUIREMENTS_ANALYSIS","PAUSED","CANCELLED"},
    "PERMISSION_REQUIRED":{"REQUIREMENTS_ANALYSIS","CANCELLED"},"AUTHENTICATION_REQUIRED":{"READY_FOR_ACTION","CANCELLED","EXPIRED"},
    "READY_FOR_ACTION":{"CONFIRMATION_REQUIRED","EXECUTING","CANCELLED"},"CONFIRMATION_REQUIRED":{"EXECUTING","CANCELLED","EXPIRED"},
    "EXECUTING":{"VERIFYING","FAILED_RECOVERABLE","FAILED_FINAL"},"VERIFYING":{"COMPLETED","COMPLETED_UNVERIFIED","FAILED_RECOVERABLE"},
    "FAILED_RECOVERABLE":{"READY_FOR_ACTION","PAUSED","CANCELLED","FAILED_FINAL"},"PAUSED":{"REQUIREMENTS_ANALYSIS","READY_FOR_ACTION","CANCELLED","EXPIRED"},
}

def transition(current:str,target:str)->str:
    if target==current:return target
    if target not in STATE_TRANSITIONS.get(current,set()): raise ValueError(f"Invalid workflow transition: {current} -> {target}")
    return target


class ToolRequest(BaseModel):
    arguments: dict[str, Any] = {}


@dataclass(frozen=True)
class ToolDefinition:
    name: str
    description: str
    request_schema: type[BaseModel]
    response_schema: type[BaseModel]
    platforms: tuple[str, ...]
    permissions: tuple[str, ...]
    risk: RiskLevel
    confirmation: str
    timeout_seconds: int
    retries: int
    idempotent: bool
    privacy: str
    available: bool = True


class IntentToolRegistry:
    def __init__(self): self._tools: dict[str, ToolDefinition] = {}
    def register(self, tool: ToolDefinition):
        if tool.name in self._tools: raise ValueError(f"Duplicate tool: {tool.name}")
        self._tools[tool.name] = tool
    def get(self, name: str): return self._tools.get(name)
    def names(self): return frozenset(self._tools)
    def validate(self, name: str, platform: str):
        tool=self.get(name)
        if not tool or not tool.available or platform not in tool.platforms: raise ValueError(f"Tool is not available: {name}")
        return tool


tool_registry=IntentToolRegistry()
for definition in (
    ToolDefinition("alarm.create","Create an alarm",ToolRequest,ToolRequest,("web","android","ios"),("alarms",),RiskLevel.LOW,"when_missing_details",20,1,True,"personal"),
    ToolDefinition("alarm.update","Update an alarm",ToolRequest,ToolRequest,("web","android","ios"),("alarms",),RiskLevel.MEDIUM,"always",20,1,True,"personal"),
    ToolDefinition("reminder.create","Create a reminder",ToolRequest,ToolRequest,("web","android","ios"),("notifications",),RiskLevel.LOW,"when_missing_details",20,1,True,"personal"),
    ToolDefinition("document.inspect","Inspect an approved document",ToolRequest,ToolRequest,("web","android","ios"),("documents",),RiskLevel.LOW,"never",60,0,True,"sensitive"),
    ToolDefinition("document.validate","Validate an approved document",ToolRequest,ToolRequest,("web","android","ios"),("documents",),RiskLevel.MEDIUM,"never",60,0,True,"sensitive"),
    ToolDefinition("portal.open","Open an official portal",ToolRequest,ToolRequest,("web","android","ios"),("external_navigation",),RiskLevel.LOW,"never",30,0,True,"public"),
    ToolDefinition("portal.submit","Submit a supported form",ToolRequest,ToolRequest,("web","android","ios"),("external_submission",),RiskLevel.HIGH,"always",120,0,True,"sensitive"),
    ToolDefinition("submission.verify","Verify a submission",ToolRequest,ToolRequest,("web","android","ios"),("external_submission",),RiskLevel.LOW,"never",60,2,True,"personal"),
    ToolDefinition("notification.send","Send an approved notification",ToolRequest,ToolRequest,("web","android","ios"),("notifications",),RiskLevel.MEDIUM,"always",30,2,True,"personal"),
): tool_registry.register(definition)


def _contains(text: str, *terms: str) -> bool:
    normalized=text.casefold()
    return any(term.casefold() in normalized for term in terms)


class IntentInterpreter:
    version=INTENT_INTERPRETER_PROMPT_VERSION
    def interpret(self, request: IntentRequest, active: WorkflowRun | None) -> IntentClassification:
        text=request.message.strip(); lower=text.casefold()
        if SECRET_PATTERN.search(text):
            return IntentClassification(domain="account_management",primary_intent="provide_authentication_secret",action_type=ActionType.REQUEST_SECURE_INPUT,confidence=.99,risk_level=RiskLevel.HIGH,required_capabilities=["secure_input"],clarification_required=False,workflow_id=active.id if active else None)
        cancel=_contains(lower,"cancel","stop it","never mind","रद्द","बंद कर दो")
        if cancel and active:
            return IntentClassification(domain=str(active.context.get("domain","automation")),primary_intent="cancel_active_workflow",action_type=ActionType.CANCEL_ACTION,confidence=.97,risk_level=RiskLevel.MEDIUM,workflow_id=active.id,references=[active.id],requested_autonomy="EXECUTE")
        alarm=_contains(lower,"alarm","wake me","jaga","जगा","उठा","अलार्म")
        reminder=_contains(lower,"remind","reminder","याद दिला")
        form=_contains(lower,"apply","application","form","आवेदन","अप्लाई")
        automation=_contains(lower,"whenever","every month","हर महीने","जब भी","automatically")
        update=_contains(lower,"instead","change","update","की जगह","कर दो") and bool(active)
        if alarm:
            entities: dict[str,Any]={}
            match=TIME_PATTERN.search(lower)
            if match: entities["time"]=re.sub(r"^at\s+","",match.group(0),flags=re.I)
            if _contains(lower,"tomorrow","कल"): entities["date"]="tomorrow"
            missing=[] if "time" in entities else ["time"]
            return IntentClassification(domain="alarm",primary_intent="update_alarm" if update else "create_alarm",action_type=ActionType.RESUME_WORKFLOW if update else (ActionType.COLLECT_INFORMATION if missing else ActionType.PREPARE_ACTION),entities=entities,missing_requirements=missing,required_capabilities=["alarm"],confidence=.94 if not update or active else .7,risk_level=RiskLevel.MEDIUM if update else RiskLevel.LOW,requested_autonomy="EXECUTE",clarification_required=bool(missing),workflow_id=active.id if update and active else None,references=[active.id] if update and active else [])
        if automation:
            return IntentClassification(domain="automation",primary_intent="create_conditional_automation",secondary_intent="bill_or_notice_monitoring" if _contains(lower,"bill","notice","बिल") else None,action_type=ActionType.CREATE_AUTOMATION,confidence=.9,risk_level=RiskLevel.MEDIUM,requested_autonomy="AUTOMATE",required_capabilities=["automation","notifications"],missing_requirements=[])
        if form:
            scholarship=_contains(lower,"scholarship","छात्रवृत्ति")
            return IntentClassification(domain="education" if scholarship else "online_forms",primary_intent="apply_for_service",secondary_intent="scholarship_application" if scholarship else None,action_type=ActionType.COLLECT_INFORMATION,confidence=.91 if scholarship else .67,risk_level=RiskLevel.HIGH,requested_autonomy="EXECUTE",required_capabilities=["dynamic_ui","document_upload","portal_session"],missing_requirements=["service_identity"] if not scholarship else ["applicant_profile","education_details","documents"],clarification_required=not scholarship)
        if reminder:
            return IntentClassification(domain="reminder",primary_intent="create_reminder",action_type=ActionType.COLLECT_INFORMATION if not TIME_PATTERN.search(lower) else ActionType.PREPARE_ACTION,confidence=.9,risk_level=RiskLevel.LOW,requested_autonomy="EXECUTE",missing_requirements=[] if TIME_PATTERN.search(lower) else ["date_time"],required_capabilities=["notifications"],clarification_required=not bool(TIME_PATTERN.search(lower)))
        if _contains(lower,"phone slow","फोन slow","फोन स्लो","mobile slow"):
            return IntentClassification(domain="technical_support",primary_intent="device_troubleshooting",action_type=ActionType.REQUEST_PERMISSION,confidence=.94,risk_level=RiskLevel.MEDIUM,requested_autonomy="GUIDED",required_capabilities=["device_diagnostics"],missing_requirements=["diagnostics_permission"])
        return IntentClassification(domain="conversation",primary_intent="conversational_reply",action_type=ActionType.REPLY_ONLY,confidence=.9,risk_level=RiskLevel.LOW,requested_autonomy="NONE")


class RequirementResolver:
    def interaction(self, intent: IntentClassification, workflow_id: str | None) -> DynamicInteraction | None:
        if not intent.missing_requirements: return None
        if all("document" in key for key in intent.missing_requirements):
            return DynamicInteraction(type="document_request",title="Required documents",description="Upload only the documents approved for this workflow.",fields=[InteractionField(id="documents",type="pdf",label="Documents",required=True)],actions=["submit","cancel"],workflow_id=workflow_id)
        if intent.domain=="alarm":
            fields=[InteractionField(id="time",type="time",label="Alarm time",required=True)]
            return DynamicInteraction(type="information_request",title="Choose a time",description="What time should I wake you?",fields=fields,actions=["submit","cancel"],workflow_id=workflow_id)
        if intent.primary_intent=="apply_for_service" and intent.secondary_intent is None:
            return DynamicInteraction(type="clarification",title="Which form?",description="Which form or service do you want to apply for?",fields=[InteractionField(id="service_identity",type="text",label="Form or service",required=True)],actions=["submit","cancel"],workflow_id=workflow_id)
        if intent.secondary_intent=="scholarship_application":
            return DynamicInteraction(type="information_request",title="Scholarship application",description="Provide the missing applicant details. Documents are requested only after this information is validated.",fields=[InteractionField(id="applicant_name",type="text",label="Applicant name",required=True),InteractionField(id="date_of_birth",type="date",label="Date of birth",required=True),InteractionField(id="education_level",type="text",label="Current education",required=True)],actions=["submit","cancel"],workflow_id=workflow_id)
        return DynamicInteraction(type="information_request",title="More information needed",description="Provide the missing information.",fields=[InteractionField(id=re.sub(r"[^a-z0-9_]","_",key.lower())[:64],type="text",label=key.replace("_"," ").title(),required=True) for key in intent.missing_requirements],actions=["submit","cancel"],workflow_id=workflow_id)


class WorkflowValidator:
    def validate(self, workflow: WorkflowDefinitionSchema, platform="web") -> dict[str,Any]:
        for step in workflow.steps:
            if step.type=="call_tool":
                if not step.tool: raise ValueError(f"Step {step.id} requires a tool")
                tool_registry.validate(step.tool,platform)
                if tool_registry.get(step.tool).risk in {RiskLevel.HIGH,RiskLevel.CRITICAL}:
                    prior=workflow.steps[:workflow.steps.index(step)]
                    if not any(x.type=="request_confirmation" for x in prior): raise ValueError("High-risk tool requires a prior confirmation step")
        graph={s.id:s.next for s in workflow.steps if s.next}; visiting=set(); visited=set()
        def visit(node):
            if node in visiting: raise ValueError("Workflow loops are not allowed")
            if node in visited:return
            visiting.add(node)
            nxt=graph.get(node)
            if nxt: visit(nxt)
            visiting.remove(node);visited.add(node)
        for node in graph: visit(node)
        return {"valid":True,"simulated":True,"step_count":len(workflow.steps),"tool_count":sum(bool(x.tool) for x in workflow.steps)}


class IntentActionRouter:
    HIGH_IMPACT={"finance","health","government_services","online_forms","education","account_management"}
    def decide(self, intent: IntentClassification, interaction: DynamicInteraction | None, permissions: list[str]) -> PolicyDecision:
        if intent.action_type==ActionType.REQUEST_SECURE_INPUT:
            ui=DynamicInteraction(type="secure_input",title="Secure input required",description="Enter this value only in the protected secure field. It will not be sent to the AI model.",fields=[InteractionField(id="secret",type="otp",label="Secure code",required=True)],actions=["authenticate","cancel"],workflow_id=intent.workflow_id)
            return PolicyDecision(outcome=RouterOutcome.HUMAN_AUTHENTICATION_REQUIRED,reason="Authentication secrets are isolated from model context",user_message="Use the secure input below; do not send the code in chat.",interaction=ui)
        if intent.action_type==ActionType.CANCEL_ACTION:
            return PolicyDecision(outcome=RouterOutcome.WORKFLOW_CONTINUATION,reason="User cancelled the active workflow",user_message="The active action has been cancelled.")
        if intent.confidence<.6:
            return PolicyDecision(outcome=RouterOutcome.DYNAMIC_UI_REQUEST,reason="Intent confidence is below the execution threshold",user_message="I need one detail before continuing.",interaction=interaction)
        if interaction:
            return PolicyDecision(outcome=RouterOutcome.DYNAMIC_UI_REQUEST,reason="Required information is missing",user_message=interaction.description,interaction=interaction)
        if intent.action_type==ActionType.REPLY_ONLY:
            return PolicyDecision(outcome=RouterOutcome.TEXT_RESPONSE,reason="No external action requested",user_message="Continue with conversational response generation.")
        if intent.action_type==ActionType.REQUEST_PERMISSION:
            ui=DynamicInteraction(type="permission_request",title="Device diagnostics permission",description="Allow one-time access to supported storage, memory, battery, and background-app diagnostics?",fields=[InteractionField(id="device_diagnostics",type="permission",label="Device diagnostics",required=True)],actions=["confirm","cancel"],workflow_id=intent.workflow_id)
            return PolicyDecision(outcome=RouterOutcome.DYNAMIC_UI_REQUEST,reason="Narrow permission is required",user_message="I need your permission before reading device diagnostics.",interaction=ui)
        if intent.action_type==ActionType.CREATE_AUTOMATION:
            ui=DynamicInteraction(type="automation_proposal",title="Review automation",description="Review the exact trigger and actions before activation.",fields=[],actions=["confirm","cancel"],workflow_id=intent.workflow_id)
            return PolicyDecision(outcome=RouterOutcome.WORKFLOW_CREATION,reason="Automations require explicit activation",user_message="Review this automation before I activate it.",interaction=ui,requires_confirmation=True)
        if intent.risk_level in {RiskLevel.HIGH,RiskLevel.CRITICAL} or intent.domain in self.HIGH_IMPACT:
            ui=DynamicInteraction(type="final_confirmation",title="Final confirmation required",description="Review all details before this high-impact action is submitted.",fields=[],actions=["confirm","cancel"],workflow_id=intent.workflow_id)
            return PolicyDecision(outcome=RouterOutcome.HUMAN_CONFIRMATION_REQUIRED,reason="High-impact actions always require confirmation",user_message="Nothing will be submitted until you confirm the complete review.",interaction=ui,requires_confirmation=True)
        if intent.action_type in {ActionType.PREPARE_ACTION,ActionType.EXECUTE_ACTION} and intent.domain=="alarm":
            return PolicyDecision(outcome=RouterOutcome.TOOL_EXECUTION_REQUEST,reason="Low-risk alarm requirements are complete",user_message="The alarm request is ready for the allowlisted action service.",tool_name="alarm.create")
        return PolicyDecision(outcome=RouterOutcome.HUMAN_CONFIRMATION_REQUIRED,reason="Action is prepared and awaits approval",user_message="Review and confirm the prepared action.",requires_confirmation=True)


class IntentEngine:
    def __init__(self): self.interpreter=IntentInterpreter(); self.resolver=RequirementResolver(); self.router=IntentActionRouter()
    def active_run(self,db,user_id,chat_id):
        query=select(WorkflowRun).where(WorkflowRun.user_id==user_id,WorkflowRun.state.notin_(("COMPLETED","FAILED_FINAL","CANCELLED","EXPIRED"))).order_by(WorkflowRun.updated_at.desc())
        if chat_id: query=query.where(WorkflowRun.chat_id==chat_id)
        return db.scalar(query.limit(1))
    def process(self,db:Session,user_id:str,request:IntentRequest):
        try: ZoneInfo(request.timezone)
        except ZoneInfoNotFoundError: request.timezone="UTC"
        active=self.active_run(db,user_id,request.chat_id)
        intent=self.interpreter.interpret(request,active)
        if active and intent.action_type==ActionType.CANCEL_ACTION:
            active.state="CANCELLED"; active.updated_at=datetime.utcnow()
        event=IntentEvent(user_id=user_id,chat_id=request.chat_id,input_hash=hashlib.sha256(request.message.encode()).hexdigest(),classification=intent.model_dump(mode="json"),policy_decision={})
        db.add(event);db.flush()
        run=active
        if intent.action_type!=ActionType.REPLY_ONLY and not run:
            run=WorkflowRun(user_id=user_id,chat_id=request.chat_id,intent_event_id=event.id,state="REQUIREMENTS_ANALYSIS",context={"domain":intent.domain,"intent":intent.primary_intent,"entities":intent.entities,"timezone":request.timezone})
            db.add(run);db.flush();intent.workflow_id=run.id
        interaction=self.resolver.interaction(intent,run.id if run else None)
        decision=self.router.decide(intent,interaction,request.granted_permissions)
        event.classification=intent.model_dump(mode="json");event.policy_decision=decision.model_dump(mode="json")
        if run:
            run.state={RouterOutcome.DYNAMIC_UI_REQUEST:"COLLECTING_INFORMATION",RouterOutcome.HUMAN_AUTHENTICATION_REQUIRED:"AUTHENTICATION_REQUIRED",RouterOutcome.HUMAN_CONFIRMATION_REQUIRED:"CONFIRMATION_REQUIRED",RouterOutcome.WORKFLOW_CREATION:"CONFIRMATION_REQUIRED",RouterOutcome.WORKFLOW_CONTINUATION:"CANCELLED"}.get(decision.outcome,"READY_FOR_ACTION")
            for key in intent.missing_requirements:
                exists=db.scalar(select(RequirementRecord).where(RequirementRecord.run_id==run.id,RequirementRecord.key==key))
                if not exists: db.add(RequirementRecord(run_id=run.id,user_id=user_id,key=key,state="REQUESTED"))
        db.commit();db.refresh(event)
        return event,intent,decision,run


intent_engine=IntentEngine()
workflow_validator=WorkflowValidator()
