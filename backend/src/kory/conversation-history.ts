/** Remove the just-persisted user row before it is appended for one provider
 * dispatch. IDs are required so identical consecutive user messages remain
 * distinct turns. */
export function excludeCurrentPersistedMessage<T extends { id: string }>(
  messages: T[],
  currentMessageId?: string,
): T[] {
  if (!currentMessageId) return messages;
  return messages.filter((message) => message.id !== currentMessageId);
}
