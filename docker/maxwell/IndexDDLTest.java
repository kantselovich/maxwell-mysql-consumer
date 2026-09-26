package com.zendesk.maxwell.schema.ddl;

public final class IndexDDLTest {
    public static void main(String[] args) {
        check("", "CREATE INDEX by_name ON `poc`.`items` (name)", "poc", "items");
        check("poc", "DROP INDEX by_name ON items", "poc", "items");
        // Unsupported target features still reach Swift, which rejects them.
        check("poc", "CREATE UNIQUE INDEX by_name ON items (name) INVISIBLE", "poc", "items");
        if (IndexDDL.parse("poc", "CREATE TABLE items (id INT)") != null) throw new AssertionError();
        boolean rejected = false;
        try { IndexDDL.parse("poc", "ALTER INDEX unknown"); }
        catch (IllegalArgumentException expected) { rejected = true; }
        if (!rejected) throw new AssertionError("Unrecognized index DDL was skipped");
        // Exercise the actual patched entry point, not just the helper.
        if (SchemaChange.parse("poc", "DROP INDEX by_name ON items").size() != 1) throw new AssertionError();
        System.out.println("PASS Maxwell standalone index capture patch");
    }
    private static void check(String context, String sql, String database, String table) {
        TableAlter change = (TableAlter) IndexDDL.parse(context, sql).get(0);
        if (!database.equals(change.database) || !table.equals(change.table)) throw new AssertionError(sql);
    }
}
