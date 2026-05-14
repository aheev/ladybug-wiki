# Parser & ANTLR4 Grammar

**Source files:** `src/parser/`, `src/antlr4/`, `src/include/parser/`

## ANTLR4 Integration

LadybugDB's Cypher parser is generated from an ANTLR4 grammar. The grammar files live in `src/antlr4/`:

```
src/antlr4/
  Cypher.g4          ← combined lexer + parser grammar (main)
  CypherLexer.g4     ← generated: tokenization rules
  CypherParser.g4    ← generated: syntactic rules
```

The ANTLR4 toolchain generates `CypherLexer.{h,cpp}` and `CypherParser.{h,cpp}` at build time. These are checked in to avoid requiring ANTLR4 at build time.

## Grammar Overview

Key rules in `Cypher.g4`:

```antlr
// Top-level entry
statement
    : regularQuery
    | standaloneCall
    | createMacro
    | ...
    ;

regularQuery
    : singleQuery (UNION ALL? singleQuery)*
    ;

singleQuery
    : readingClause* (updatingClause+ withClause?)*
      returnClause?
    ;

// MATCH clause with optional WHERE
matchClause
    : MATCH patternList whereClause?
    ;

// Pattern: comma-separated path patterns
patternList
    : pattern (COMMA pattern)*
    ;

pattern
    : nodePattern (patternElement)*
    ;

patternElement
    : relationshipPattern nodePattern
    ;

nodePattern
    : LP (variable COLON)? labelExpression propertyKeyValuePairs? RP
    ;

// Expressions (full Cypher expression precedence)
expression
    : orExpression
    ;
```

## CST → AST Transformation

ANTLR4 produces a Concrete Syntax Tree (CST). LadybugDB transforms it into its own internal AST via a visitor pattern:

```cpp
// transformer.cpp
class Transformer : public CypherBaseVisitor {
    // Visit each CST node type and produce an AST node:

    antlrcpp::Any visitStatement(CypherParser::StatementContext* ctx) override {
        return visitRegularQuery(ctx->regularQuery());
    }

    antlrcpp::Any visitMatchClause(CypherParser::MatchClauseContext* ctx) override {
        auto pattern = visitPatternList(ctx->patternList());
        auto where   = ctx->whereClause() ? visitWhereClause(ctx->whereClause()) : nullptr;
        return make_unique<ParsedMatchClause>(move(pattern), move(where));
    }

    antlrcpp::Any visitNodePattern(CypherParser::NodePatternContext* ctx) override {
        string varName = ctx->variable() ? ctx->variable()->getText() : "";
        string label   = ctx->labelExpression() ? ctx->labelExpression()->getText() : "";
        return make_unique<NodePattern>(varName, label);
    }
};
```

## AST Node Hierarchy

```
Statement
  ├─ ParsedQuery
  │    ├─ ParsedMatchClause
  │    │    ├─ ParsedPattern (list)
  │    │    │    └─ PatternElement (nodePattern, relPattern pairs)
  │    │    └─ ParsedExpression (WHERE)
  │    ├─ ParsedReturnClause
  │    │    ├─ ParsedReturnItem (list)
  │    │    ├─ ParsedOrderBy (optional)
  │    │    └─ ParsedLimit (optional)
  │    └─ ParsedWhereClause (top-level WHERE)
  └─ ... (CREATE, MERGE, DELETE, SET, etc.)
```

All `Parsed*` types are in `src/include/parser/parsed_expression/` and `src/include/parser/query/`.

## Expression Parsing

Cypher expressions follow strict precedence (low to high):

```
OR → XOR → AND → NOT
  → comparison (=, <>, <, >, <=, >=, IS NULL, IN, STARTS WITH, ...)
  → addition / subtraction
  → multiplication / division / modulo
  → power
  → unary minus / not
  → string/list operators (contains, ends with, [])
  → property access (.prop)
  → function calls (count(), sum(), ...)
  → literals, variables, parameters ($param)
```

## Error Handling

ANTLR4 errors are intercepted by a custom `ErrorListener`:

```cpp
class LbugErrorListener : public antlr4::BaseErrorListener {
    void syntaxError(antlr4::Recognizer*, antlr4::Token* offendingSymbol,
                     size_t line, size_t charPositionInLine,
                     const string& msg, ...) override {
        throw ParserException(
            "Parser Error: " + msg + " (line " + to_string(line) + 
            ", column " + to_string(charPositionInLine) + ")"
        );
    }
};
```

## Cypher Extensions

LadybugDB extends standard openCypher with:

| Extension | Example |
|-----------|---------|
| `LOAD FROM` | `LOAD FROM 'data.csv' (header=true) RETURN *` |
| `COPY FROM` | `COPY Person FROM 'people.csv'` |
| `CREATE MACRO` | `CREATE MACRO myFunc(x) AS x + 1` |
| `CALL` (table function) | `CALL db_tables() RETURN *` |
| `ATTACH` | `ATTACH 'other.lbug' AS db2` |
| Recursive pattern | `MATCH (a)-[:KNOWS*1..3]->(b)` |

These extensions are added as additional grammar rules in `Cypher.g4`.

## Related Files

- `src/antlr4/Cypher.g4` — the grammar
- `src/parser/transformer.cpp` — CST → AST visitor
- `src/include/parser/parsed_expression/` — expression AST node types
- `src/include/parser/query/` — statement/clause AST node types
- `src/parser/cypher_parser.cpp` — entry point: `CypherParser::parse(string)`
