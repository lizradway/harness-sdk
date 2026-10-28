import { createInterface } from 'node:readline/promises'
import { Agent, InterruptResponseContent, tool } from '@strands-agents/sdk'
import { HumanInTheLoop } from '@strands-agents/sdk/vended-interventions/hitl'
import { z } from 'zod'

async function classifierExample() {
  // --8<-- [start:classifier]
  const listFiles = tool({
    name: 'list_files',
    description: 'List the files in a directory.',
    inputSchema: z.object({ directory: z.string() }),
    callback: () => ['app.log', 'app.log.1', 'app.log.2'],
  })

  const deleteFiles = tool({
    name: 'delete_files',
    description: 'Delete the files at the given paths.',
    inputSchema: z.object({ paths: z.array(z.string()) }),
    callback: ({ paths }) => `Deleted ${paths.length} files`,
  })

  const agent = new Agent({
    tools: [listFiles, deleteFiles],
    interventions: [new HumanInTheLoop({ classifier: true })],
    printer: false,
  })

  const terminal = createInterface({ input: process.stdin, output: process.stdout })
  let result = await agent.invoke('Delete the rotated logs in /var/log/app')

  // The agent stops before each tool call the classifier rates risky
  while (result.stopReason === 'interrupt') {
    const responses: InterruptResponseContent[] = []
    for (const interrupt of result.interrupts ?? []) {
      const answer = await terminal.question(`${String(interrupt.reason)} (y/n): `)
      responses.push(
        new InterruptResponseContent({ interruptId: interrupt.id, response: answer })
      )
    }
    result = await agent.invoke(responses)
  }
  terminal.close()

  console.log(result.toString())
  // --8<-- [end:classifier]
}

void classifierExample
