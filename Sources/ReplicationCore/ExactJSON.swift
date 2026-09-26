import Foundation

/// JSON numbers remain their original decimal text: neither Double nor Decimal can
/// represent every MySQL DECIMAL(65,30). Used for row values and nested JSON alike.
public indirect enum ExactJSON: Equatable {
    case null, bool(Bool), number(String), string(String), array([ExactJSON]), object([String: ExactJSON])

    public init(data: Data) throws {
        var parser = Parser(bytes: Array(data))
        self = try parser.value(depth: 0)
        parser.space()
        guard parser.offset == parser.bytes.count else { throw POCError("Trailing JSON input") }
    }
    public var object: [String: ExactJSON]? { if case .object(let v) = self { return v }; return nil }
    public var string: String? { if case .string(let v) = self { return v }; return nil }
    public var json: String {
        switch self {
        case .null: return "null"
        case .bool(let v): return v ? "true" : "false"
        case .number(let v): return v
        case .string(let v): return String(decoding: try! JSONEncoder().encode(v), as: UTF8.self)
        case .array(let v): return "[" + v.map(\.json).joined(separator: ",") + "]"
        case .object(let v): return "{" + v.keys.sorted().map { ExactJSON.string($0).json + ":" + v[$0]!.json }.joined(separator: ",") + "}"
        }
    }
}

private struct Parser {
    let bytes: [UInt8]
    var offset = 0
    mutating func space() { while offset < bytes.count && [9, 10, 13, 32].contains(bytes[offset]) { offset += 1 } }
    mutating func take(_ c: UInt8) -> Bool {
        space()
        if offset < bytes.count && bytes[offset] == c { offset += 1; return true }
        return false
    }
    mutating func string() throws -> String {
        space()
        let start = offset
        guard take(34) else { throw POCError("Expected JSON string") }
        while offset < bytes.count {
            let c = bytes[offset]; offset += 1
            if c == 34 { return try JSONDecoder().decode(String.self, from: Data(bytes[start..<offset])) }
            if c == 92 { offset += 1 }
        }
        throw POCError("Unterminated JSON string")
    }
    mutating func value(depth: Int) throws -> ExactJSON {
        guard depth < 100 else { throw POCError("JSON nesting limit") }
        space()
        guard offset < bytes.count else { throw POCError("Incomplete JSON") }
        switch bytes[offset] {
        case 34: return .string(try string())
        case 123:
            offset += 1
            var result: [String: ExactJSON] = [:]
            if take(125) { return .object(result) }
            repeat {
                let key = try string()
                guard result[key] == nil, take(58) else { throw POCError("Duplicate key or missing colon") }
                result[key] = try value(depth: depth + 1)
                if take(125) { return .object(result) }
            } while take(44)
            throw POCError("Invalid JSON object")
        case 91:
            offset += 1
            var result: [ExactJSON] = []
            if take(93) { return .array(result) }
            repeat {
                result.append(try value(depth: depth + 1))
                if take(93) { return .array(result) }
            } while take(44)
            throw POCError("Invalid JSON array")
        default:
            let start = offset
            while offset < bytes.count && ![9, 10, 13, 32, 44, 93, 125].contains(bytes[offset]) { offset += 1 }
            let token = String(decoding: bytes[start..<offset], as: UTF8.self)
            switch token {
            case "null": return .null
            case "true": return .bool(true)
            case "false": return .bool(false)
            default:
                guard token.range(of: #"^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$"#, options: .regularExpression) != nil else {
                    throw POCError("Invalid JSON token")
                }
                return .number(token)
            }
        }
    }
}
