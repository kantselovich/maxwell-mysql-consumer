import {test} from "node:test";
import assert from "node:assert/strict";
import {parseDatabaseJSON, snapshots, rowSet, rowsMatch, schemaSet, columnsFor, cellText} from "../src/components/database-data.js";

test("database JSON retains exact integers, decimals, Unicode and strings", () => {
  assert.deepEqual(parseDatabaseJSON('{"id":18446744073709551615,"decimal":1234567890.123456789,"text":"你好 🐘","null":null}'), {id:"18446744073709551615", decimal:"1234567890.123456789", text:"你好 🐘", null:null});
  assert.throws(() => parseDatabaseJSON('{broken'));
});
test("snapshot discovery pairs files, deduplicates refs and prefers workload captures", () => {
  const groups = snapshots(["readiness-markers-rows", "crud-records-schema", "crud-records-rows", "crud-records-rows", "other-diffs"].map(name => ({path:`run/${name}.json`})));
  assert.equal(groups.length, 2); assert.equal(groups[0].name, "crud-records");
  assert.equal(groups[0].schema.path, "run/crud-records-schema.json");
  assert.equal(groups[1].schema, undefined);
});
test("row comparison ignores ordering but keeps duplicate counts and missing fields", () => {
  assert.equal(rowsMatch([{id:"1", value:"a"}, {id:"2"}], [{id:"2"}, {value:"a", id:"1"}]), true);
  assert.equal(rowsMatch([{id:"1"}, {id:"1"}], [{id:"1"}]), false);
  assert.equal(rowsMatch([{id:"1", value:null}], [{id:"1"}]), false);
  assert.equal(rowsMatch([], []), true);
  assert.equal(rowsMatch([], null), null);
  assert.equal(rowsMatch([{value:{nested:"bad"}}], []), null);
});
test("invalid row/schema captures cannot produce successful comparisons", () => {
  for (const value of [undefined, {}, null, [null], [1]]) assert.equal(rowSet(value), null);
  for (const value of [undefined, {}, {exists:true, columns:[null], indexes:[]}]) assert.equal(schemaSet(value), null);
  assert.deepEqual(schemaSet({exists:false, columns:[], indexes:[]}), {exists:false, columns:[], indexes:[]});
});
test("cell display distinguishes null, absent, empty and literal marker strings", () => {
  assert.deepEqual([undefined, null, "", "NULL", "Absent", "0", "0.000001", "\n"].map(cellText), ["Absent", "NULL", '\"\"', '\"NULL\"', '\"Absent\"', "0", "0.000001", "\n"]);
  assert.deepEqual(columnsFor([{id:"1", extra:"x"}], {columns:[{name:"id"}, {name:"optional"}, null]}), ["id", "optional", "extra"]);
});
