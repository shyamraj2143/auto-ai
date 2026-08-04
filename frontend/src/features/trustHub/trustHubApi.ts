import { apiFetch } from "../../api/client";
export type HubSummary = { policy_count:number; active_leases:number; at_risk_commitments:number; pending_receipts:number; blocked_actions:number; expiring_leases:number; pause:{active:boolean;reason:string|null;expires_at:string|null}; last_sync:string };
export type HubPolicy={id:string;name:string;description:string;domain:string;priority:number;conditions:Record<string,unknown>;effect:"ALLOW"|"REQUIRE_CONFIRMATION"|"DENY";enabled:boolean;version:number;updated_at:string};
export type PolicyEvaluation={decision:string;matched_policy_ids:string[];explanation:string};
export type PolicyAudit=PolicyEvaluation&{id:string;domain:string;action_type:string;context:Record<string,unknown>;created_at:string};
export type ConsentLease={id:string;capability:string;purpose:string;fields:string[];status:string;expires_at:string};
export type AuthoritySetting={domain:string;level:"SUGGEST_ONLY"|"PREPARE_AND_ASK"|"EXECUTE_AFTER_CONFIRMATION"|"EXECUTE_AND_REPORT"|"BLOCKED";temporary_until:string|null};
export type Commitment={id:string;deliverable:string;owner:string;due_at:string;estimated_minutes:number;status:string;feasibility:string;conflict_ids:string[];evidence:Record<string,unknown>;recovery_note:string;version:number;receipt_id?:string};
export type GraphNode={id:string;node_type:string;label:string;details:Record<string,unknown>;source_type:string;source_id:string;archived:boolean;created_at:string}; export type GraphEdge={id:string;from_node_id:string;to_node_id:string;edge_type:string;confidence:number;source:string};
export const trustHubApi = {
  summary:(token:string)=>apiFetch<HubSummary>("/hub/summary",{token,operation:"hub.summary"}),
  setPause:(token:string,payload:{active:boolean;reason:string;expires_at:string|null})=>apiFetch<HubSummary["pause"]>("/hub/emergency-pause",{method:"PUT",token,operation:"hub.pause",body:JSON.stringify(payload)}),
  policies:(token:string,search="")=>apiFetch<HubPolicy[]>(`/hub/policies?search=${encodeURIComponent(search)}`,{token,operation:"hub.policies"}),
  createPolicy:(token:string,payload:Omit<HubPolicy,"id"|"version"|"updated_at">)=>apiFetch<HubPolicy>("/hub/policies",{method:"POST",token,operation:"hub.policy.create",body:JSON.stringify(payload)}),
  updatePolicy:(token:string,policy:HubPolicy)=>apiFetch<HubPolicy>(`/hub/policies/${policy.id}`,{method:"PUT",token,operation:"hub.policy.update",body:JSON.stringify(policy)}),
  deletePolicy:(token:string,id:string)=>apiFetch<void>(`/hub/policies/${id}`,{method:"DELETE",token,operation:"hub.policy.delete"}),
  duplicatePolicy:(token:string,id:string)=>apiFetch<HubPolicy>(`/hub/policies/${id}/duplicate`,{method:"POST",token,operation:"hub.policy.duplicate"}),
  evaluatePolicy:(token:string,payload:{domain:string;action_type:string;context:Record<string,unknown>})=>apiFetch<PolicyEvaluation>("/hub/policies/evaluate",{method:"POST",token,operation:"hub.policy.evaluate",body:JSON.stringify(payload)}),
  policyAudit:(token:string)=>apiFetch<PolicyAudit[]>("/hub/policies/audit",{token,operation:"hub.policy.audit"}),
  leases:(token:string)=>apiFetch<ConsentLease[]>("/hub/consent-leases",{token,operation:"hub.leases"}),
  createLease:(token:string,payload:{capability:string;purpose:string;fields:string[];expires_at:string;os_permission_granted:boolean})=>apiFetch<ConsentLease>("/hub/consent-leases",{method:"POST",token,operation:"hub.lease.create",body:JSON.stringify(payload)}),
  revokeLease:(token:string,id:string)=>apiFetch<ConsentLease>(`/hub/consent-leases/${id}/revoke`,{method:"POST",token,operation:"hub.lease.revoke"}),
  renewLease:(token:string,id:string,expires_at:string)=>apiFetch<ConsentLease>(`/hub/consent-leases/${id}/renew`,{method:"POST",token,operation:"hub.lease.renew",body:JSON.stringify({expires_at})}),
  authorities:(token:string)=>apiFetch<AuthoritySetting[]>("/hub/authority-settings",{token,operation:"hub.authorities"}),
  setAuthority:(token:string,domain:string,level:AuthoritySetting["level"])=>apiFetch<AuthoritySetting>(`/hub/authority-settings/${domain}`,{method:"PUT",token,operation:"hub.authority.update",body:JSON.stringify({level})}),
  commitments:(token:string)=>apiFetch<Commitment[]>("/hub/commitments",{token,operation:"hub.commitments"}),
  createCommitment:(token:string,payload:{deliverable:string;owner:string;due_at:string;estimated_minutes:number},key:string)=>apiFetch<Commitment>("/hub/commitments",{method:"POST",token,operation:"hub.commitment.create",headers:{"idempotency-key":key},body:JSON.stringify(payload)}),
  transitionCommitment:(token:string,item:Commitment,action:string,extra:Record<string,unknown>={})=>apiFetch<Commitment>(`/hub/commitments/${item.id}/transition`,{method:"POST",token,operation:`hub.commitment.${action}`,headers:{"idempotency-key":`${item.id}-${action}-${item.version}`},body:JSON.stringify({action,version:item.version,...extra})}),
  lifeMap:(token:string)=>apiFetch<{nodes:GraphNode[];edges:GraphEdge[]}>("/hub/life-map",{token,operation:"hub.lifeMap"}),
  createGraphNode:(token:string,payload:{node_type:string;label:string;details:Record<string,unknown>})=>apiFetch<GraphNode>("/hub/life-map/nodes",{method:"POST",token,operation:"hub.graph.node.create",body:JSON.stringify(payload)}),
  archiveGraphNode:(token:string,id:string)=>apiFetch<void>(`/hub/life-map/nodes/${id}`,{method:"DELETE",token,operation:"hub.graph.node.archive"}),
  createGraphEdge:(token:string,payload:{from_node_id:string;to_node_id:string;edge_type:string})=>apiFetch<GraphEdge>("/hub/life-map/edges",{method:"POST",token,operation:"hub.graph.edge.create",body:JSON.stringify(payload)}),
  graphImpact:(token:string,id:string)=>apiFetch<{source:GraphNode;impacted:GraphNode[];bounded:boolean}>(`/hub/life-map/nodes/${id}/impact`,{token,operation:"hub.graph.impact"})
};
