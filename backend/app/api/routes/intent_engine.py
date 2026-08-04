import hashlib
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models.intent_engine import ActionReceipt, IntentFeedbackEvent, PreferenceSuggestion, RequirementRecord, SecureChallenge, WorkflowDefinition, WorkflowRun
from app.models.message import Message
from app.models.user import User
from app.schemas.intent_engine import FeedbackCreate, IntentRequest, IntentResponse, InteractionSubmission, SecureChallengeCreate, SecureChallengeSubmit, WorkflowDefinitionSchema
from app.services.intent_engine import intent_engine, workflow_validator

router=APIRouter(prefix="/intent-engine",tags=["intent-engine"])


def _run(db:Session,user:User,run_id:str)->WorkflowRun:
    item=db.scalar(select(WorkflowRun).where(WorkflowRun.id==run_id,WorkflowRun.user_id==user.id))
    if not item: raise HTTPException(404,"Workflow not found")
    return item


@router.post("/interpret",response_model=IntentResponse)
def interpret(payload:IntentRequest,db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    event,intent,decision,run=intent_engine.process(db,user.id,payload)
    if payload.chat_id and decision.outcome.value!="TEXT_RESPONSE":
        sensitive=decision.outcome.value=="HUMAN_AUTHENTICATION_REQUIRED"
        db.add_all([
            Message(chat_id=payload.chat_id,user_id=user.id,role="user",content="[Sensitive authentication value withheld from chat]" if sensitive else payload.message,message_metadata={"intent_event_id":event.id}),
            Message(chat_id=payload.chat_id,user_id=user.id,role="assistant",content=decision.user_message,message_metadata={"intent_event_id":event.id,"intent":intent.model_dump(mode="json"),"intent_interaction":decision.interaction.model_dump(mode="json") if decision.interaction else None}),
        ])
        db.commit()
    return IntentResponse(event_id=event.id,intent=intent,decision=decision,workflow_id=run.id if run else None)


@router.get("/workflows")
def workflows(db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    definitions=list(db.scalars(select(WorkflowDefinition).where(WorkflowDefinition.user_id==user.id).order_by(WorkflowDefinition.updated_at.desc())))
    runs=list(db.scalars(select(WorkflowRun).where(WorkflowRun.user_id==user.id).order_by(WorkflowRun.updated_at.desc()).limit(100)))
    return {"definitions":definitions,"runs":runs}

@router.get("/receipts")
def receipts(db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    return list(db.scalars(select(ActionReceipt).where(ActionReceipt.user_id==user.id).order_by(ActionReceipt.created_at.desc()).limit(100)))


@router.post("/workflows",status_code=status.HTTP_201_CREATED)
def create_workflow(payload:WorkflowDefinitionSchema,db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    try: report=workflow_validator.validate(payload)
    except ValueError as exc: raise HTTPException(422,str(exc)) from exc
    row=WorkflowDefinition(user_id=user.id,name=payload.workflow_name,version=payload.version,definition=payload.model_dump(mode="json"),validation_report=report,enabled=False)
    db.add(row);db.commit();db.refresh(row);return row


@router.patch("/workflows/{workflow_id}")
def update_workflow(workflow_id:str,enabled:bool,db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    row=db.scalar(select(WorkflowDefinition).where(WorkflowDefinition.id==workflow_id,WorkflowDefinition.user_id==user.id))
    if not row: raise HTTPException(404,"Workflow not found")
    row.enabled=enabled;db.commit();db.refresh(row);return row


@router.delete("/workflows/{workflow_id}",status_code=204)
def delete_workflow(workflow_id:str,db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    row=db.scalar(select(WorkflowDefinition).where(WorkflowDefinition.id==workflow_id,WorkflowDefinition.user_id==user.id))
    if not row: raise HTTPException(404,"Workflow not found")
    db.delete(row);db.commit()


@router.post("/workflows/{run_id}/interaction")
def submit_interaction(run_id:str,payload:InteractionSubmission,db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    run=_run(db,user,run_id)
    if payload.decision=="cancel": run.state="CANCELLED"
    elif payload.decision=="pause": run.state="PAUSED"
    else:
        requirements={x.key:x for x in db.scalars(select(RequirementRecord).where(RequirementRecord.run_id==run.id,RequirementRecord.user_id==user.id))}
        for key,value in payload.values.items():
            if any(token in key.lower() for token in ("password","otp","pin","secret")): raise HTTPException(422,"Authentication secrets must use the secure input channel")
            item=requirements.get(key)
            if item: item.value={"value":value};item.state="PROVIDED"
        run.context={**(run.context or {}),"provided":{**(run.context or {}).get("provided",{}),**payload.values}}
        run.state="CONFIRMATION_REQUIRED" if payload.decision=="confirm" else "REQUIREMENTS_ANALYSIS"
    run.updated_at=datetime.utcnow();db.commit();return {"workflow_id":run.id,"state":run.state}


@router.post("/secure-challenges",status_code=201)
def create_challenge(payload:SecureChallengeCreate,db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    _run(db,user,payload.workflow_id)
    row=SecureChallenge(user_id=user.id,run_id=payload.workflow_id,kind=payload.kind,destination_hash=hashlib.sha256(payload.destination.encode()).hexdigest(),expires_at=datetime.utcnow()+timedelta(seconds=payload.expires_in_seconds))
    db.add(row);db.commit();db.refresh(row)
    return {"id":row.id,"kind":row.kind,"status":row.status,"expires_at":row.expires_at}


@router.post("/secure-challenges/{challenge_id}/submit")
def submit_challenge(challenge_id:str,payload:SecureChallengeSubmit,db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    row=db.scalar(select(SecureChallenge).where(SecureChallenge.id==challenge_id,SecureChallenge.user_id==user.id))
    if not row: raise HTTPException(404,"Secure challenge not found")
    if row.status!="pending" or row.expires_at<datetime.utcnow(): row.status="expired";db.commit();raise HTTPException(410,"Secure challenge expired")
    row.secret_hash=None;row.status="consumed";row.consumed_at=datetime.utcnow()
    run=_run(db,user,row.run_id);run.state="READY_FOR_ACTION"
    db.commit()
    # The raw value exists only in this request scope and is never returned, logged, persisted, or sent to a model.
    return {"id":row.id,"status":"consumed","workflow_id":row.run_id}


@router.post("/feedback",status_code=201)
def feedback(payload:FeedbackCreate,db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    evaluation={"event_type":payload.event_type,"corrected":payload.event_type=="intent_corrected","result":payload.payload.get("result"),"error_type":payload.payload.get("error_type")}
    row=IntentFeedbackEvent(user_id=user.id,intent_event_id=payload.intent_event_id,event_type=payload.event_type,payload=payload.payload,evaluation_payload=evaluation)
    db.add(row);db.commit();db.refresh(row);return row

@router.patch("/preferences/{suggestion_id}")
def preference_decision(suggestion_id:str,accept:bool,db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    row=db.scalar(select(PreferenceSuggestion).where(PreferenceSuggestion.id==suggestion_id,PreferenceSuggestion.user_id==user.id))
    if not row: raise HTTPException(404,"Preference suggestion not found")
    row.status="accepted" if accept else "rejected";db.commit();db.refresh(row);return row
