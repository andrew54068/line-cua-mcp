// No real LINE input: parse the observed cua-driver AX search states.
import assert from 'node:assert/strict';
import { searchFieldState } from '../dist/line.js';
const tree = (fields) => `- [0] AXWindow "LINE"\n  - [1] AXTextArea\n${fields}\n- [20] AXMenuBar\n- [30] AXWindow "LINE"\n  - [31] AXTextField = "duplicate mirror"\n`;
assert.deepEqual(searchFieldState(tree('  - [2] AXTextField [actions=[raise]]')), {index:2,value:''});
assert.deepEqual(searchFieldState(tree('  - [8] AXTextField = "THE HIDEOUT" [actions=[raise]]')), {index:8,value:'THE HIDEOUT'});
assert.deepEqual(searchFieldState(tree('  - [9] AXTextField = "say \\"hi\\"" [actions=[raise]]')), {index:9,value:'say "hi"'});
assert.throws(() => searchFieldState('- [0] AXMenuBar\n  - [2] AXTextField'));
assert.throws(() => searchFieldState(tree('  - [2] AXTextArea')));
assert.throws(() => searchFieldState(tree('  - [2] AXTextField\n  - [3] AXTextField')));
assert.throws(() => searchFieldState('- [0] AXWindow "Open"\n  - [2] AXTextField'));
assert.throws(() => searchFieldState('- [0] AXWindow "Open"\n  - [2] AXTextField\n' + tree('  - [4] AXTextField')));
console.log('search: 8 checks passed (no UI input)');
