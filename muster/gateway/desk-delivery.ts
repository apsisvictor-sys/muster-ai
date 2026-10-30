/**
 * How a research-card tap reaches a seat (command center blueprint r6, D14): the transport half of
 * `tapCard`'s `deliver` port. The desk owner (`research-desk.ts`) says what the message holds; this file
 * frames it with the message protocol's lines (VR24-10 C3, C4: the `TO:` line and the `ID:` line, from the
 * gateway's own constants) and sends it through the one inbox path Henry's `send_to_architect` uses.
 */

import { type DeskDeliver, type DeskMessage } from "../research-desk.ts";
import { ID_LINE_PREFIX, MESSAGE_TO_LINES, inboxSender } from "./tools.ts";

/**
 * The stored text: the fixed line of the tap, the recipient's TO line, the ID line, a blank line, the fixed
 * sentence, a blank line, then the card block under the outside-input header. Nothing of the card sits outside
 * the block.
 */
export function composeDeskText(message: DeskMessage): string {
	return [message.header, MESSAGE_TO_LINES[message.to], `${ID_LINE_PREFIX}${message.id}`, "", message.intro, "", ...message.block].join("\n");
}

/** The `deliver` port over the inbox: one message to the architect's or the orchestrator's inbox, sent as `message.from`. */
export function deskDelivery(options: { stateDir: string }): DeskDeliver {
	return async (message) => {
		await inboxSender({ stateDir: options.stateDir, agentId: message.from, recipientId: message.to })(composeDeskText(message), undefined, message.id);
	};
}
