# Parser and AST Reference

**Primary sources read**

- `src/include/parser/parser.h`, `src/parser/parser.cpp`
- `src/include/parser/transformer.h`, `src/parser/transformer.cpp`
- `src/include/parser/antlr_parser/lbug_cypher_parser.h`, `src/parser/antlr_parser/lbug_cypher_parser.cpp`
- `src/include/parser/antlr_parser/parser_error_listener.h`, `src/parser/antlr_parser/parser_error_listener.cpp`
- `src/include/parser/antlr_parser/parser_error_strategy.h`, `src/parser/antlr_parser/parser_error_strategy.cpp`
- `src/antlr4/Cypher.g4`
- `src/include/parser/statement.h`
- `src/include/parser/query/regular_query.h`
- `src/include/parser/query/single_query.h`
- `src/include/parser/query/query_part.h`
- `src/include/parser/query/reading_clause/reading_clause.h`
- `src/include/parser/query/reading_clause/match_clause.h`
- `src/include/parser/query/reading_clause/join_hint.h`
- `src/include/parser/query/return_with_clause/projection_body.h`
- `src/include/parser/query/return_with_clause/return_clause.h`
- `src/include/parser/query/graph_pattern/pattern_element.h`
- `src/include/parser/query/graph_pattern/pattern_element_chain.h`
- `src/include/parser/query/graph_pattern/node_pattern.h`
- `src/include/parser/query/graph_pattern/rel_pattern.h`
- `src/include/parser/expression/parsed_expression.h` plus parsed expression subclasses
- `src/parser/transform/transform_expression.cpp`
- `src/parser/transform/transform_graph_pattern.cpp`
- `test/include/test_runner/test_parser.h`, `test/test_runner/test_parser.cpp`

This page documents the concrete parser pipeline that turns a Cypher string into LadybugDB's parsed AST. Names and field descriptions below match the C++ sources.

## 1. Entry point: `parser::Parser::parseQuery`

The public entry point is:

```cpp
static std::vector<std::shared_ptr<Statement>> Parser::parseQuery(
    std::string_view query,
    std::vector<extension::TransformerExtension*> transformerExtensions = {});
```

`Parser::parseQuery` in `src/parser/parser.cpp` does five things in order:

1. Copies the input into a mutable `std::string`.
2. Trims leading whitespace with `StringUtils::ltrim` and `StringUtils::ltrimNewlines`.
3. Rejects the empty-query case before ANTLR runs.
4. Builds the ANTLR pipeline:
   - `ANTLRInputStream`
   - `CypherLexer`
   - `CommonTokenStream`
   - `LbugCypherParser`
5. Instantiates `Transformer transformer(*lbugCypherParser.iC_Statements(), ...)` and returns `transformer.transform()`.

Two design details matter:

- The return type is `std::vector<std::shared_ptr<Statement>>`, not a single statement. The grammar root accepts multiple statements in one input.
- Parsing is deliberately split into two stages: ANTLR produces a concrete parse tree; `Transformer` converts that tree into LadybugDB-owned AST types.

## 2. ANTLR integration layer

The grammar lives in `src/antlr4/Cypher.g4`. LadybugDB inserts two custom control points on top of generated ANTLR code.

### 2.1 `LbugCypherParser`

`LbugCypherParser` subclasses the generated `CypherParser` and overrides semantic-notification hooks:

- `notifyQueryNotConcludeWithReturn`
- `notifyNodePatternWithoutParentheses`
- `notifyInvalidNotEqualOperator`
- `notifyEmptyToken`
- `notifyReturnNotAtEnd`
- `notifyNonBinaryComparison`

These methods call `notifyErrorListeners(...)` with product-specific diagnostics such as:

- `Query must conclude with RETURN clause`
- `RETURN can only be used at the end of the query`
- `Unknown operation '!=' (you probably meant to use '<>')`
- `Non-binary comparison (e.g. a=b=c) is not supported`

### 2.2 `ParserErrorListener`

`ParserErrorListener` inherits `antlr4::BaseErrorListener`. Its `syntaxError(...)` throws `common::ParserException` and formats:

- ANTLR's message
- line number
- character offset
- the original source line
- a caret underline built by `formatUnderLineError(...)`

### 2.3 `ParserErrorStrategy`

`ParserErrorStrategy` subclasses `antlr4::DefaultErrorStrategy` and overrides `reportNoViableAlternative(...)`. It rewrites raw ANTLR failures into clearer diagnostics such as:

- `Unexpected end of input`
- `Invalid input <...>: expected rule ...`

## 3. Transformer architecture

`parser::Transformer` is the real parser front-end once ANTLR has accepted the token stream.

Its constructor stores:

- `CypherParser::IC_StatementsContext& root`
- `std::vector<extension::TransformerExtension*> transformerExtensions`

The top-level workflow is `Transformer::transform()`:

```cpp
for (auto& oc_Statement : root.oC_Cypher()) {
    auto statement = transformStatement(*oc_Statement->oC_Statement());
    if (oc_Statement->oC_AnyCypherOption()) {
        ... wrap in ExplainStatement ...
    }
    statements.push_back(std::move(statement));
}
```

Important consequences:

- `EXPLAIN`/`PROFILE` are wrapper statements, not flags on the underlying query AST.
- `ExplainType::PROFILE`, `ExplainType::LOGICAL_PLAN`, and `ExplainType::PHYSICAL_PLAN` are decided during transformation.
- Extension syntax can hook directly into AST construction via `transformExtensionStatement(...)`.

## 4. Statement dispatch

`Transformer::transformStatement(...)` recognizes:

- query statements: `transformQuery`
- DDL: create table, create rel group, create index, create sequence, create type, drop, alter
- copy/import/export: `transformCopyFrom`, `transformCopyTo`, `transformExportDatabase`, `transformImportDatabase`
- procedural/configuration statements: `transformStandaloneCall`, `transformTransaction`, `transformExtension`
- macro and metadata statements: `transformCreateMacro`, `transformCommentOn`
- database/graph routing: attach, detach, use database, create graph, use graph

## 5. Core AST base class: `parser::Statement`

All parser output derives from `parser::Statement` in `src/include/parser/statement.h`.

Stored fields and behavior:

- `double parsingTime`
- `common::StatementType statementType`
- `bool internal`
- `requireTransaction()` returns `false` only for `StatementType::TRANSACTION`
- `setToInternal()` marks internally generated statements whose result should not be returned to users

## 6. Query AST structure

### 6.1 `RegularQuery`

`parser::RegularQuery` owns:

- `std::vector<SingleQuery> singleQueries`
- `std::vector<bool> isUnionAll`

`addSingleQuery(SingleQuery, bool isUnionAllQuery)` appends each additional branch in a `UNION` / `UNION ALL` chain.

### 6.2 `SingleQuery`

`parser::SingleQuery` stores:

- `std::vector<QueryPart> queryParts`
- `std::vector<std::unique_ptr<ReadingClause>> readingClauses`
- `std::vector<std::unique_ptr<UpdatingClause>> updatingClauses`
- `std::optional<ReturnClause> returnClause`

### 6.3 `QueryPart`

Each `QueryPart` wraps:

- `std::vector<std::unique_ptr<ReadingClause>> readingClauses`
- `std::vector<std::unique_ptr<UpdatingClause>> updatingClauses`
- `WithClause withClause`

A `WITH` is therefore a query boundary object, not just another projection node.

## 7. Reading clauses

### 7.1 `ReadingClause`

All reading clauses derive from `parser::ReadingClause`, which stores:

- `common::ClauseType clauseType`
- `std::unique_ptr<ParsedExpression> wherePredicate`

### 7.2 `MatchClause`

`parser::MatchClause` adds:

- `std::vector<PatternElement> patternElements`
- `common::MatchClauseType matchClauseType`
- `std::shared_ptr<JoinHintNode> hintRoot`

So parser output explicitly preserves:

- `MATCH` versus `OPTIONAL MATCH`
- full graph patterns
- join-order hints

## 8. Projection AST

`ProjectionBody` is the parser-side representation of `RETURN` and `WITH` bodies.

Fields:

- `bool isDistinct`
- `std::vector<std::unique_ptr<ParsedExpression>> projectionExpressions`
- `std::vector<std::unique_ptr<ParsedExpression>> orderByExpressions`
- `std::vector<bool> isAscOrders`
- `std::unique_ptr<ParsedExpression> skipExpression`
- `std::unique_ptr<ParsedExpression> limitExpression`

`ReturnClause` simply owns a `ProjectionBody`.

## 9. Graph-pattern AST

### 9.1 `PatternElement`

A `PatternElement` owns:

- optional `pathName`
- the first `NodePattern`
- `std::vector<PatternElementChain> patternElementChains`

### 9.2 `PatternElementChain`

A chain element is just:

- `RelPattern relPattern`
- `NodePattern nodePattern`

### 9.3 `NodePattern`

`NodePattern` stores:

- `std::string variableName`
- `std::vector<std::string> tableNames`
- `std::vector<s_parsed_expr_pair> propertyKeyVals`

### 9.4 `RelPattern`

`RelPattern` subclasses `NodePattern` and adds:

- `common::QueryRelType relType`
- `ArrowDirection arrowDirection`
- `RecursiveRelPatternInfo recursiveInfo`

`RecursiveRelPatternInfo` contains:

- `lowerBound`
- `upperBound`
- `weightPropertyName`
- `relName`
- `nodeName`
- `whereExpression`
- `hasProjection`
- `relProjectionList`
- `nodeProjectionList`

## 10. Recursive-pattern decoding

`Transformer::transformRelationshipPattern(...)` maps grammar constructs into `common::QueryRelType` values.

Observed mappings in the source:

- default recursive pattern -> `VARIABLE_LENGTH_WALK`
- `TRAIL` -> `VARIABLE_LENGTH_TRAIL`
- `ACYCLIC` -> `VARIABLE_LENGTH_ACYCLIC`
- `SHORTEST` -> `SHORTEST`
- `ALL SHORTEST` -> `ALL_SHORTEST`
- `WSHORTEST(property)` -> `WEIGHTED_SHORTEST`
- `ALL WSHORTEST(property)` -> `ALL_WEIGHTED_SHORTEST`

Bounds are parsed as strings first and validated later during binding.

## 11. Parsed expression model

The parser expression root is `parser::ParsedExpression`.

Core fields:

- `common::ExpressionType type`
- `std::string alias`
- `std::string rawName`
- `parsed_expr_vector children`

Important subclasses read during source review:

- `ParsedLiteralExpression`
- `ParsedVariableExpression`
- `ParsedPropertyExpression`
- `ParsedFunctionExpression`
- `ParsedCaseExpression`
- `ParsedLambdaExpression`
- `ParsedParameterExpression`
- `ParsedSubqueryExpression`

## 12. Expression lowering rules in `transform_expression.cpp`

The transformer encodes precedence explicitly as a stack of methods:

- `transformExpression`
- `transformOrExpression`
- `transformXorExpression`
- `transformAndExpression`
- `transformNotExpression`
- `transformComparisonExpression`
- bitwise operators
- additive / multiplicative / power
- unary / factorial
- string-list-null operators
- property / atom / literal / function / case / subquery

### 12.1 Boolean and comparison nodes

Boolean operators become plain `ParsedExpression` nodes with `ExpressionType` such as:

- `OR`
- `XOR`
- `AND`
- `NOT`
- `EQUALS`
- `NOT_EQUALS`
- `GREATER_THAN`
- `GREATER_THAN_EQUALS`
- `LESS_THAN`
- `LESS_THAN_EQUALS`

### 12.2 Operator-to-function rewrites

Many infix operators are normalized immediately into `ParsedFunctionExpression`:

- `|` -> `BitwiseOrFunction::name`
- `&` -> `BitwiseAndFunction::name`
- `<<` -> `BitShiftLeftFunction::name`
- `>>` -> `BitShiftRightFunction::name`
- `^` -> `PowerFunction::name`
- unary `-` -> `NegateFunction::name`
- `STARTS WITH` -> `StartsWithFunction::name`
- `ENDS WITH` -> `EndsWithFunction::name`
- `CONTAINS` -> `ContainsFunction::name`
- regex match -> `RegexpFullMatchFunction::name`
- `x IN y` -> `ListContainsFunction::name` with arguments reversed to `(list, element)`
- slicing -> `ListSliceFunction::name`

### 12.3 Unary minus on numeric literals is folded during parsing

`transformUnaryAddSubtractOrFactorialExpression(...)` special-cases number literals so `-123` is parsed as one signed literal rather than `Negate(123)`.

## 13. Identifier and string handling

`Transformer::transformSymbolicName(...)` strips backticks from escaped identifiers.

`Transformer::transformStringLiteral(...)` decodes:

- `\\`
- `\'`
- `\"`
- `\b`
- `\f`
- `\n`
- `\r`
- `\t`
- `\xHH`
- `\uHHHH`
- `\UHHHHHHHH`

## 14. Parser extension hook

If a statement is not handled by the built-in transformer, `transformExtensionStatement(...)` iterates `transformerExtensions` and asks each extension to transform the ANTLR subtree.

If no extension accepts it, the parser throws:

> `Failed parse the statement. Do you forget to load the extension?`

## 15. What the parser guarantees

By the time control leaves the parser subsystem, later stages can assume:

- syntax is valid or an exception has already been thrown
- statement type is known
- `EXPLAIN` / `PROFILE` wrapping has been materialized as `ExplainStatement`
- query parts and clause boundaries are explicit
- path patterns are decomposed into node/relationship chain objects
- recursive pattern syntax has been converted into `QueryRelType` plus `RecursiveRelPatternInfo`
- many operators have already been normalized into function-style parsed expressions
- aliases, raw names, and clause-local `WHERE` expressions are preserved

What the parser does **not** decide:

- catalog resolution
- variable scoping correctness across clauses
- expression logical types
- aggregate/grouping semantics
- join order
- factorization layout

## 16. Parser testing path

LadybugDB's `.test` harness is parsed by `testing::TestParser`, but it still matters because many parser regressions surface through these tests.

Important files:

- `test/include/test_runner/test_parser.h`
- `test/test_runner/test_parser.cpp`

The harness tokenizes `.test` directives such as `-STATEMENT`, `----`, dataset declarations, skip flags, and expected-result blocks.

## 17. Mental model

```text
query string
  -> CypherLexer / CommonTokenStream
  -> LbugCypherParser + custom diagnostics
  -> Transformer
  -> Statement / ParsedExpression / PatternElement AST
```

The parser is intentionally syntax-heavy and semantics-light. It preserves enough structure for the binder to make catalog-, type-, and scope-aware decisions without dealing with ANTLR parse trees directly.
