// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {PayrailEscrow, IERC20} from "../src/PayrailEscrow.sol";

interface Vm {
    function prank(address) external;
    function warp(uint256) external;
    function expectRevert(bytes4) external;
}

/// ERC-20 that returns bool
contract MockToken is IERC20 {
    mapping(address => uint256) public override balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external virtual returns (bool) {
        require(balanceOf[msg.sender] >= a, "bal");
        balanceOf[msg.sender] -= a; balanceOf[to] += a; return true;
    }
    function transferFrom(address f, address to, uint256 a) external virtual returns (bool) {
        require(balanceOf[f] >= a && allowance[f][msg.sender] >= a, "bal/allow");
        allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[to] += a; return true;
    }
}

/// USDT-style: transfer/transferFrom return NOTHING
contract NoReturnToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external { allowance[msg.sender][s] = a; }
    function transfer(address to, uint256 a) external { require(balanceOf[msg.sender] >= a); balanceOf[msg.sender] -= a; balanceOf[to] += a; }
    function transferFrom(address f, address to, uint256 a) external {
        require(balanceOf[f] >= a && allowance[f][msg.sender] >= a);
        allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[to] += a;
    }
}

contract PayrailEscrowTest {
    Vm constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);
    MockToken token;
    PayrailEscrow esc;
    address constant OPERATOR = address(0xA11CE);
    address constant FEE = address(0xFEE);
    address constant BUYER = address(0xB0B);
    address constant SELLER = address(0x5E11);
    address constant STRANGER = address(0xBAD);

    function setUp() public {
        token = new MockToken();
        esc = new PayrailEscrow(IERC20(address(token)), OPERATOR, FEE, 300, 1 days);
        token.mint(BUYER, 1_000_000);
        vm.prank(BUYER);
        token.approve(address(esc), type(uint256).max);
    }

    function eq(uint256 a, uint256 b, string memory m) internal pure { require(a == b, m); }

    function _invariant() internal view {
        // contract token balance covers everything it owes (holds are not in `available`, so add them via totalLiabilities check)
        require(token.balanceOf(address(esc)) >= esc.totalLiabilities(), "undercollateralised");
    }

    function test_happy_path_fee_split() public {
        setUp();
        vm.prank(BUYER); esc.deposit(100_000);
        vm.prank(OPERATOR); esc.placeHold(bytes32(uint256(1)), BUYER, SELLER, 20_000);
        eq(esc.available(BUYER), 80_000, "available after hold");
        vm.prank(OPERATOR); esc.capture(bytes32(uint256(1)));
        eq(esc.earnings(SELLER), 19_400, "seller 97%");
        eq(esc.earnings(FEE), 600, "fee 3%");
        vm.prank(SELLER); esc.claim();
        vm.prank(FEE); esc.claim();
        eq(token.balanceOf(SELLER), 19_400, "seller paid");
        eq(token.balanceOf(FEE), 600, "fee paid");
        eq(token.balanceOf(address(esc)), 80_000, "buyer remainder stays");
        _invariant();
    }

    function test_fee_rounds_half_up() public {
        setUp();
        vm.prank(BUYER); esc.deposit(1_000);
        vm.prank(OPERATOR); esc.placeHold(bytes32(uint256(2)), BUYER, SELLER, 50); // 50*3% = 1.5 -> 2
        vm.prank(OPERATOR); esc.capture(bytes32(uint256(2)));
        eq(esc.earnings(FEE), 2, "round half up");
        eq(esc.earnings(SELLER), 48, "remainder to seller");
    }

    function test_release_returns_everything() public {
        setUp();
        vm.prank(BUYER); esc.deposit(50_000);
        vm.prank(OPERATOR); esc.placeHold(bytes32(uint256(3)), BUYER, SELLER, 20_000);
        vm.prank(OPERATOR); esc.release(bytes32(uint256(3)));
        eq(esc.available(BUYER), 50_000, "fully restored");
        eq(esc.earnings(SELLER), 0, "seller earns nothing");
        vm.prank(BUYER); esc.withdraw(50_000);
        eq(token.balanceOf(BUYER), 1_000_000, "buyer whole");
    }

    function test_expire_after_timeout_by_anyone() public {
        setUp();
        vm.prank(BUYER); esc.deposit(50_000);
        vm.prank(OPERATOR); esc.placeHold(bytes32(uint256(4)), BUYER, SELLER, 20_000);
        vm.expectRevert(PayrailEscrow.NotExpired.selector);
        vm.prank(STRANGER); esc.expire(bytes32(uint256(4)));
        vm.warp(block.timestamp + 1 days);
        vm.prank(STRANGER); esc.expire(bytes32(uint256(4)));
        eq(esc.available(BUYER), 50_000, "returned to buyer");
    }

    function test_only_operator_and_no_double_resolution() public {
        setUp();
        vm.prank(BUYER); esc.deposit(50_000);
        vm.expectRevert(PayrailEscrow.NotOperator.selector);
        vm.prank(STRANGER); esc.placeHold(bytes32(uint256(5)), BUYER, STRANGER, 10_000);
        vm.prank(OPERATOR); esc.placeHold(bytes32(uint256(5)), BUYER, SELLER, 10_000);
        vm.expectRevert(PayrailEscrow.HoldExists.selector);
        vm.prank(OPERATOR); esc.placeHold(bytes32(uint256(5)), BUYER, SELLER, 10_000);
        vm.prank(OPERATOR); esc.capture(bytes32(uint256(5)));
        vm.expectRevert(PayrailEscrow.HoldNotOpen.selector);
        vm.prank(OPERATOR); esc.capture(bytes32(uint256(5)));
        vm.expectRevert(PayrailEscrow.HoldNotOpen.selector);
        vm.prank(OPERATOR); esc.release(bytes32(uint256(5)));
        vm.expectRevert(PayrailEscrow.HoldNotOpen.selector);
        vm.prank(STRANGER); esc.expire(bytes32(uint256(5)));
    }

    function test_cannot_hold_more_than_available_and_cannot_withdraw_held() public {
        setUp();
        vm.prank(BUYER); esc.deposit(30_000);
        vm.expectRevert(PayrailEscrow.InsufficientBalance.selector);
        vm.prank(OPERATOR); esc.placeHold(bytes32(uint256(6)), BUYER, SELLER, 30_001);
        vm.prank(OPERATOR); esc.placeHold(bytes32(uint256(6)), BUYER, SELLER, 30_000);
        vm.expectRevert(PayrailEscrow.InsufficientBalance.selector);
        vm.prank(BUYER); esc.withdraw(1);
    }

    function test_zero_amounts_and_bad_config_rejected() public {
        setUp();
        vm.expectRevert(PayrailEscrow.ZeroAmount.selector);
        vm.prank(BUYER); esc.deposit(0);
        vm.expectRevert(PayrailEscrow.BadConfig.selector);
        new PayrailEscrow(IERC20(address(token)), OPERATOR, FEE, 1_001, 1 days);
        vm.expectRevert(PayrailEscrow.BadConfig.selector);
        new PayrailEscrow(IERC20(address(token)), OPERATOR, FEE, 300, 10 minutes);
    }

    function test_works_with_tokens_that_return_nothing() public {
        NoReturnToken t = new NoReturnToken();
        PayrailEscrow e = new PayrailEscrow(IERC20(address(t)), OPERATOR, FEE, 300, 1 days);
        t.mint(BUYER, 10_000);
        vm.prank(BUYER); t.approve(address(e), 10_000);
        vm.prank(BUYER); e.deposit(10_000);
        vm.prank(OPERATOR); e.placeHold(bytes32(uint256(7)), BUYER, SELLER, 10_000);
        vm.prank(OPERATOR); e.capture(bytes32(uint256(7)));
        vm.prank(SELLER); e.claim();
        eq(t.balanceOf(SELLER), 9_700, "paid with a no-return token");
    }

    /// fuzz: whatever the amounts, the escrow stays fully collateralised and fee + seller == amount
    function testFuzz_conservation(uint96 depositAmt, uint96 holdAmt, bool doCapture) public {
        setUp();
        uint256 d = uint256(depositAmt) % 1_000_000 + 1;
        uint256 h = uint256(holdAmt) % d + 1;
        vm.prank(BUYER); esc.deposit(d);
        vm.prank(OPERATOR); esc.placeHold(bytes32(uint256(8)), BUYER, SELLER, h);
        if (doCapture) {
            vm.prank(OPERATOR); esc.capture(bytes32(uint256(8)));
            eq(esc.earnings(SELLER) + esc.earnings(FEE), h, "split sums to amount");
        } else {
            vm.prank(OPERATOR); esc.release(bytes32(uint256(8)));
            eq(esc.available(BUYER), d, "released in full");
        }
        _invariant();
        eq(esc.totalLiabilities(), d, "liabilities equal deposits");
    }
}
