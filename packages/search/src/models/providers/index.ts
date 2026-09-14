/**
 * Side-effect barrel — importing this module registers all bundled
 * embedding handlers (openai, voyage, google, custom-embedding).
 */
import './openai.ts'
import './voyage.ts'
import './google.ts'
import './custom-embedding.ts'
