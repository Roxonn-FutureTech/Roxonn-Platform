import { parseBountyCommand } from './server/github';
console.log('IMPORT_OK', JSON.stringify(parseBountyCommand('/bounty 10 XDC')));
