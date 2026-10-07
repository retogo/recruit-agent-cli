#!/usr/bin/env bun
import { main } from "./src/adapters/driving/cli/index.ts";

const code = await main(process.argv);
process.exit(code);
