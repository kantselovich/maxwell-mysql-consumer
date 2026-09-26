package com.zendesk.maxwell.schema.ddl;

import java.util.Collections;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** POC capture adapter: secondary indexes do not change Maxwell's row decoder,
 * but they must still pass through its schema journal and ordered DDL producer.
 * Keep the original SQL in DDLMap; Swift alone decides whether it can apply it.
 */
public final class IndexDDL {
    private static final String ID = "(?:`[A-Za-z_][A-Za-z0-9_]*`|[A-Za-z_][A-Za-z0-9_]*)";
    private static final Pattern START = Pattern.compile(
        "(?is)\\A\\s*(?:ALTER|CREATE|DROP)\\s+(?:(?:ONLINE|OFFLINE|UNIQUE|FULLTEXT|SPATIAL)\\s+)*INDEX\\b");
    private static final Pattern TARGET = Pattern.compile(
        "(?is)\\A\\s*(?:CREATE|DROP)\\s+(?:(?:UNIQUE|FULLTEXT|SPATIAL)\\s+)?INDEX\\s+" + ID
        + "(?:\\s+USING\\s+[A-Za-z]+)?\\s+ON\\s+(?<first>" + ID + ")"
        + "(?:\\s*\\.\\s*(?<second>" + ID + "))?(?=\\s|\\(|;|$)");

    public static List<SchemaChange> parse(String currentDB, String sql) {
        if (!START.matcher(sql).find()) return null;
        Matcher match = TARGET.matcher(sql);
        if (!match.find()) throw new IllegalArgumentException("Unsupported index DDL capture syntax: " + sql);
        String first = match.group("first").replace("`", "");
        String second = match.group("second");
        String database = second == null ? currentDB : first;
        String table = second == null ? first : second.replace("`", "");
        if (database == null || database.isEmpty()) throw new IllegalArgumentException("Index DDL without database context");
        return Collections.singletonList(new TableAlter(database, table));
    }
}
