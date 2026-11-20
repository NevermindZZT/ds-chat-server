import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

// Match the DSH preset declaration contract while owning distinct metadata.
// This public Loader marker preserves nested plugin entries until activation.
export default class ChatPreset {
  static inject = ['agentPresets']
  static [Symbol.for('cordis.group')] = true
  static Config = Schema.object({
    id: Schema.string().required(),
    name: Schema.string(),
    description: Schema.string(),
    order: Schema.number(),
    plugins: Schema.array(Schema.any()).required(),
  })

  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
  }

  async *[Service.init]() {
    yield await this.ctx.agentPresets.register(this.config)
  }
}
