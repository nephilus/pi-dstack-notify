import type { DeliveryLedger } from './ledger.ts';
import type { TestOwnerEvidenceProvider } from './owner-evidence.ts';
import { decodeOwnerObservation, ownerSourceRequest } from './owner-control.ts';
import type { StoredOwnerOriginal, OwnerObservation } from './owner-control.ts';
import type { PublicationContext } from './types.ts';
import { held } from './safety.ts';
import { verifyStoredOriginalRead } from './inbox.ts';

function live(context:PublicationContext):void{if(context.signal.aborted)held();}
/** Internal shared fresh-read path for the NEXT tick. No public refresh/tool.
 * guard is an additional lifecycle/config fence, NOT a proof verifier; closed
 * observations are minted only by canonical/source verification below. */
export async function readOwnerObservation(original:StoredOwnerOriginal,provider:TestOwnerEvidenceProvider,
  context:PublicationContext,secrets:readonly string[],guard:()=>void):Promise<OwnerObservation>{
  original=structuredClone(original);
  const check=async()=>{live(context);guard();const host=await context.hostCheck();live(context);guard();
    if(host.session_id!==context.observed.session_id||host.project_path!==context.observed.project_path)held();};
  await check();
  const read=await context.inboxRead({message_id:original.target.message_id,thread_id:original.target.thread_id},{signal:context.signal});
  live(context);guard();
  // Invalid originals cannot even trigger a later mirror-source native lookup.
  verifyStoredOriginalRead(read,original.target,original.body,secrets,original.review_link);
  await check();
  const request=ownerSourceRequest(provider,original);
  const source=request?await context.inboxRead(request,{signal:context.signal}):null;
  await check();return decodeOwnerObservation(provider,original,read,source,secrets);
}
/** Real same-DB control transaction; later public observation integration is
 * deliberately absent until fresh-context tick implementation. */
export async function observeStoredOwnerRequest(ledger:DeliveryLedger,original:StoredOwnerOriginal,
  provider:TestOwnerEvidenceProvider,context:PublicationContext,secrets:readonly string[],guard:()=>void):Promise<string>{
  original=structuredClone(original);
  const check=()=>{live(context);ledger.checkFence();guard();};
  const observation=await readOwnerObservation(original,provider,context,secrets,check);check();
  return ledger.applyOwnerObservation(original.identity,observation);
}
