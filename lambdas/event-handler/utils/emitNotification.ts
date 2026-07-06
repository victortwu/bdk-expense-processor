import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge'
import { NotificationDetail } from '../types'

const ebClient = new EventBridgeClient({})

export const emitNotification = async (detail: NotificationDetail): Promise<void> => {
  try {
    await ebClient.send(
      new PutEventsCommand({
        Entries: [
          {
            Source: 'bdk.expense-processor',
            DetailType: 'ExpenseNotification',
            Detail: JSON.stringify(detail),
          },
        ],
      }),
    )
  } catch (err) {
    // Notifications are best-effort — log but don't throw
    console.error('Failed to emit notification:', err)
  }
}
