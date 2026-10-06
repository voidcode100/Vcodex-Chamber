import type { Message, Part } from "@/lib/opencode/model"
import { sortMessagesChronologically } from "./message-ordering"

function filterIdentifiedParts(parts: Part[]): Part[] {
  return parts.filter((part) => !!part?.id)
}

export type OptimisticItem = {
  message: Message
  parts: Part[]
}

export type MessagePage = {
  session: Message[]
  part: { id: string; part: Part[] }[]
  cursor?: string
  complete: boolean
}

const containsAllPartsByID = (currentParts: Part[] | undefined, requiredParts: Part[]) => {
  if (!currentParts) return requiredParts.length === 0
  const currentPartIDs = new Set(currentParts.map((part) => part.id))
  return requiredParts.every((part) => currentPartIDs.has(part.id))
}

const mergeParts = (currentParts: Part[] | undefined, optimisticParts: Part[]) => {
  if (!currentParts) return filterIdentifiedParts(optimisticParts)
  const next = [...currentParts]
  const partIDs = new Set(currentParts.map((part) => part.id))
  let changed = false
  for (const part of optimisticParts) {
    if (partIDs.has(part.id)) continue
    partIDs.add(part.id)
    next.push(part)
    changed = true
  }
  if (!changed) return currentParts
  return next
}

function messageText(parts: Part[] | undefined): string {
  return (parts ?? [])
    .filter((part): part is Part & { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
}

function isSamePrompt(candidate: Message, candidateParts: Part[] | undefined, optimistic: OptimisticItem): boolean {
  if (candidate.role !== "user" || optimistic.message.role !== "user") return false
  const left = messageText(candidateParts).trim()
  const right = messageText(optimistic.parts).trim()
  if (!left || !right || left !== right) return false
  // Do not collapse an old repeated prompt into a new send. Server and local
  // timestamps are normally close, while persisted history is far away.
  const created = candidate.time?.created
  const optimisticCreated = optimistic.message.time?.created
  return typeof created !== "number" || typeof optimisticCreated !== "number"
    || Math.abs(created - optimisticCreated) < 5 * 60 * 1000
}

export function mergeOptimisticPage(page: MessagePage, items: OptimisticItem[]) {
  if (items.length === 0) return { ...page, confirmed: [] as string[] }

  const session = [...page.session]
  const messageIDs = new Set(session.map((message) => message.id))
  const partsByMessageID = new Map(page.part.map((item) => [item.id, filterIdentifiedParts(item.part)]))
  const confirmed: string[] = []

  for (const item of items) {
    // Codex assigns a fresh UUID to the persisted user item even when the
    // request carried OpenChamber's clientUserMessageId. Find that item by
    // content and re-key it to the optimistic id before merging.
    const matchingIndex = session.findIndex((candidate) =>
      candidate.id === item.message.id || isSamePrompt(candidate, partsByMessageID.get(candidate.id), item),
    )
    if (matchingIndex >= 0) {
      const matching = session[matchingIndex]
      const matchingID = matching.id
      const matchingParts = partsByMessageID.get(matchingID) ?? []
      if (matchingID !== item.message.id) {
        session.splice(matchingIndex, 1)
        messageIDs.delete(matchingID)
        partsByMessageID.delete(matchingID)
        session.push({ ...matching, id: item.message.id })
        messageIDs.add(item.message.id)
        partsByMessageID.set(item.message.id, matchingParts.map((part) => ({ ...part, messageID: item.message.id })))
      }
      // The server record is authoritative. Confirm the optimistic item
      // immediately instead of merging its local text part with the echoed
      // server part, which would duplicate the content inside one bubble.
      if (isSamePrompt(matching, matchingParts, item) || matchingID !== item.message.id) {
        if (matchingID === item.message.id) {
          partsByMessageID.set(item.message.id, matchingParts.map((part) => ({ ...part, messageID: item.message.id })))
        }
        confirmed.push(item.message.id)
        continue
      }
    }
    const messageExists = messageIDs.has(item.message.id)
    if (!messageExists) {
      messageIDs.add(item.message.id)
      session.push(item.message)
    }

    const currentParts = partsByMessageID.get(item.message.id)
    if (messageExists && containsAllPartsByID(currentParts, item.parts)) {
      confirmed.push(item.message.id)
      continue
    }

    partsByMessageID.set(item.message.id, mergeParts(currentParts, item.parts))
  }

  return {
    cursor: page.cursor,
    complete: page.complete,
    session: sortMessagesChronologically(session),
    part: [...partsByMessageID].map(([id, part]) => ({ id, part })),
    confirmed,
  }
}

/** Merge two chronologically sorted message arrays by identity, deduplicating.
 *  Preserves existing references for items that already exist — avoids
 *  unnecessary React re-renders when prepending older history. */
export function mergeMessages<T extends Message>(existingMessages: readonly T[], incomingMessages: readonly T[]) {
  const messagesByID = new Map(existingMessages.map((item) => [item.id, item] as const))
  let changed = false
  for (const item of incomingMessages) {
    if (!messagesByID.has(item.id)) {
      messagesByID.set(item.id, item)
      changed = true
    }
  }
  if (!changed) return existingMessages as T[]
  return sortMessagesChronologically([...messagesByID.values()])
}
