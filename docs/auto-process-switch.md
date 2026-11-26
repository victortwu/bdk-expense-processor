# Auto-process arming switch (`autoProcess`)

`config.ts` sets `autoProcess` per stage. It controls `Enabled` on the SQS event source mapping that connects the
`ExpenseProcessorQueue` to the `EventHandler` Lambda (`lib/stacks/expense-event-stack.ts`).

| Stage | `autoProcess` | Effect |
|-------|---------------|--------|
| Beta  | `true`        | Events are consumed and booked automatically. |
| Prod  | `false`       | Mapping deployed disabled. Nothing is auto-booked to QBO. |

All `aws` commands below target the Prod account: `--profile datamgmt-prod --region us-west-2`.

## While disarmed

- The EventBridge rule keeps delivering `DocumentProcessed` (financial) events to the queue.
- Messages stay in the queue (`ApproximateNumberOfMessages` grows). Prod sets `queueRetentionDays: 14` on the main queue
  (Beta keeps the SQS default of 4 days). The DLQ always uses the SQS maximum (`SQS_MAX_RETENTION_DAYS`, 14 days) so a
  dead-lettered message never loses time. The DLQ only receives messages that failed 3 receives.
- **Queued messages expire after 14 days and are deleted silently.** If Prod stays disarmed longer than that, events
  are lost. Set a CloudWatch alarm on `ApproximateAgeOfOldestMessage` for `ExpenseProcessorQueue` (for example,
  threshold 10 days = 864000 seconds), or put a calendar reminder at day 10, and either arm or deal with the backlog.
- The human path (Expense API: correct-and-submit, from-document, rules) is unaffected.

## Arm

1. Edit `config.ts`: set `autoProcess: true` for Prod. Also update the single Prod assertion in
   `test/expense-event-stack.test.ts` ("Prod config is disarmed"), which expects `Enabled: false`; otherwise the test
   suite fails. Nothing else needs to change: the arm/disarm branches are tested on synthetic stage objects.
2. `npx cdk diff Prod-BDK-ExpenseProcessorEventStack --profile datamgmt-prod`. The only change must be
   `Enabled: false` removed (absent means enabled) on `AWS::Lambda::EventSourceMapping`.
3. `npx cdk deploy Prod-BDK-ExpenseProcessorEventStack --profile datamgmt-prod` (from the main checkout, Node 24, `TMPDIR=/tmp`).
4. Confirm `State` is `Enabled`; if it still shows `Disabled`, run the manual re-enable command below
   (see "Re-enable a drift-disabled mapping"):
   `aws lambda list-event-source-mappings --function-name Prod-BDK-ExpenseProcessor-EventHandler --profile datamgmt-prod --region us-west-2`
5. Buffered messages drain. Review each resulting expense row before trusting the next batch.

## Disarm

1. Set `autoProcess: false`, run the same `cdk diff` (expect `Enabled: false` added) and `cdk deploy`.
2. Emergency without a deploy (state drifts from CDK until the next deploy; set the flag to match afterwards):
   `aws lambda update-event-source-mapping --uuid <uuid> --no-enabled --profile datamgmt-prod --region us-west-2`
   (find the uuid with
   `aws lambda list-event-source-mappings --function-name Prod-BDK-ExpenseProcessor-EventHandler --profile datamgmt-prod --region us-west-2`).
   In-flight invocations finish; queued messages stay in the queue.

## Re-enable a drift-disabled mapping

If the mapping was disabled by hand (or otherwise drifted to disabled) while `config.ts` says `autoProcess: true`,
re-enable it without a deploy:

`aws lambda update-event-source-mapping --uuid <uuid> --enabled --profile datamgmt-prod --region us-west-2`

Then confirm with `list-event-source-mappings` (above) that `State` is `Enabled`.

## Verify disabled behavior

Not exercised against AWS. Standard SQS/Lambda semantics: a disabled mapping stops polling, so messages
are not received and remain visible. Verify in Beta by disabling the mapping (command above, with the Beta profile and
region), sending one test event, and checking `ApproximateNumberOfMessages >= 1` and zero EventHandler invocations; then
re-enable.
